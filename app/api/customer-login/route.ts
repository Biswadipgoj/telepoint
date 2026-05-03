import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { aadhaar, mobile, customer_id } = body as { aadhaar?: string; mobile?: string; customer_id?: string };

  const serviceClient = createServiceClient();

  // Direct load by customer_id (from multi-loan selection)
  if (customer_id) {
    const { data: customer } = await serviceClient
      .from('customers')
      .select(`
        id, retailer_id, customer_name, father_name, aadhaar, mobile,
        alternate_number_1, alternate_number_2,
        model_no, imei, purchase_value, down_payment, disburse_amount,
        purchase_date, emi_due_day, emi_amount, emi_tenure,
        first_emi_charge_amount, first_emi_charge_paid_at,
        customer_photo_url, status,
        retailer:retailers(name, mobile)
      `)
      .eq('id', customer_id)
      .single();

    if (!customer) {
      return NextResponse.json({ error: 'Customer not found' }, { status: 404 });
    }

    const { data: emis } = await serviceClient
      .from('emi_schedule')
      .select('id, emi_no, due_date, amount, status, paid_at, mode, partial_paid_amount, partial_paid_at, fine_amount, fine_waived, fine_paid_amount, fine_paid_at')
      .eq('customer_id', customer.id)
      .order('emi_no');

    const { data: breakdown } = await serviceClient.rpc('get_due_breakdown', {
      p_customer_id: customer.id,
    });

    // Fetch active broadcast messages for this customer's retailer
    const { data: broadcasts } = await serviceClient
      .from('broadcast_messages')
      .select('id, message, image_url, expires_at, sender_name, sender_role')
      .eq('target_retailer_id', customer.retailer_id)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false });

    return NextResponse.json({ customer, emis: emis || [], breakdown, broadcasts: broadcasts || [] });
  }

  const cleanAadhaar = (aadhaar ?? '').replace(/\D/g, '');
  const cleanMobile = (mobile ?? '').replace(/\D/g, '');

  if (!cleanAadhaar && !cleanMobile) {
    return NextResponse.json({ error: 'Provide Aadhaar or mobile number to login' }, { status: 400 });
  }
  if (cleanAadhaar && cleanAadhaar.length !== 12) {
    return NextResponse.json({ error: 'Aadhaar must be exactly 12 digits' }, { status: 400 });
  }
  if (cleanMobile && cleanMobile.length !== 10) {
    return NextResponse.json({ error: 'Mobile must be exactly 10 digits' }, { status: 400 });
  }

  let query = serviceClient
    .from('customers')
    .select(`
      id, retailer_id, customer_name, father_name, aadhaar, mobile,
      alternate_number_1, alternate_number_2,
      model_no, imei, purchase_value, down_payment, disburse_amount,
      purchase_date, emi_due_day, emi_amount, emi_tenure,
      first_emi_charge_amount, first_emi_charge_paid_at,
      customer_photo_url, status,
      retailer:retailers(name, mobile)
    `);

  if (cleanAadhaar) {
    query = query.eq('aadhaar', cleanAadhaar);
    if (cleanMobile) {
      query = query.eq('mobile', cleanMobile);
    }
  } else {
    query = query.eq('mobile', cleanMobile);
  }

  const { data: customers, error } = await query;

  if (error) {
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }

  if (!customers || customers.length === 0) {
    return NextResponse.json(
      { error: 'No matching customer found. Check your Aadhaar or Mobile number.' },
      { status: 401 }
    );
  }

  // Multi-loan support: if multiple customers found, return all of them
  if (customers.length > 1) {
    // Return list for UI to show selection
    return NextResponse.json({
      multi: true,
      customers: customers.map(c => ({
        id: c.id,
        customer_name: c.customer_name,
        imei: c.imei,
        model_no: c.model_no,
        mobile: c.mobile,
        status: c.status,
        emi_amount: c.emi_amount,
        retailer: c.retailer,
      })),
    });
  }

  const customer = customers[0];

  const { data: emis } = await serviceClient
    .from('emi_schedule')
    .select('id, emi_no, due_date, amount, status, paid_at, mode, partial_paid_amount, partial_paid_at, fine_amount, fine_waived, fine_paid_amount, fine_paid_at')
    .eq('customer_id', customer.id)
    .order('emi_no');

  const { data: breakdown } = await serviceClient.rpc('get_due_breakdown', {
    p_customer_id: customer.id,
  });

  // Fetch active broadcast messages for this customer's retailer
  const { data: broadcasts } = await serviceClient
    .from('broadcast_messages')
    .select('id, message, image_url, expires_at, sender_name, sender_role')
    .eq('target_retailer_id', (customer as Record<string, unknown>).retailer_id as string)
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false });

  return NextResponse.json({
    customer,
    emis: emis || [],
    breakdown,
    broadcasts: broadcasts || [],
  });
}
