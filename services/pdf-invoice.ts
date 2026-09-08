import PDFDocument from 'pdfkit';
import { query } from './db';

interface InvoiceItem {
  productName: string;
  hsnCode: string;
  quantity: number;
  unitPrice: number;
  gstRate: number;
  taxableAmount: number;
  gstAmount: number;
  totalAmount: number;
}

interface InvoiceData {
  billId: string;
  invoiceNumber: string;
  date: string;
  customerRef: string | null;
  items: InvoiceItem[];
  subtotal: number;
  cgstAmount: number;
  sgstAmount: number;
  roundingAdjustment: number;
  totalAmount: number;
  shopName: string;
  shopAddress: string;
  shopGstin: string;
}

async function fetchInvoiceData(billId: string): Promise<InvoiceData> {
  const billRows = await query<{
    id: string;
    customer_ref: string | null;
    subtotal: string;
    cgst_amount: string;
    sgst_amount: string;
    rounding_adjustment: string;
    total_amount: string;
    finalized_at: Date;
  }>(
    `SELECT id, customer_ref, subtotal, cgst_amount, sgst_amount, 
            rounding_adjustment, total_amount, finalized_at
     FROM bills
     WHERE id = $1`,
    [billId]
  );

  if (billRows.length === 0) {
    throw new Error('Bill not found');
  }

  const bill = billRows[0];

  const itemRows = await query<{
    product_name: string;
    hsn_code: string;
    quantity: string;
    unit_price: string;
    gst_rate: string;
    line_subtotal: string;
  }>(
    `SELECT p.name AS product_name, p.hsn_code, bi.quantity, 
        bi.unit_price, bi.gst_rate, bi.line_subtotal
     FROM bill_items bi
     JOIN products p ON p.id = bi.product_id
     WHERE bi.bill_id = $1 AND bi.status = 'active'
     ORDER BY bi.created_at ASC`,
    [billId]
  );

  const items: InvoiceItem[] = itemRows.map((row) => {
    const taxableAmount = Number(row.line_subtotal);
    const gstAmount = round2(taxableAmount * (Number(row.gst_rate) / 100));
    return {
      productName: row.product_name,
      hsnCode: row.hsn_code,
      quantity: Number(row.quantity),
      unitPrice: Number(row.unit_price),
      gstRate: Number(row.gst_rate),
      taxableAmount,
      gstAmount,
      totalAmount: round2(taxableAmount + gstAmount),
    };
  });

  const invoiceNumber = `INV-${bill.id.slice(0, 8).toUpperCase()}`;
  const date = bill.finalized_at.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  return {
    billId: bill.id,
    invoiceNumber,
    date,
    customerRef: bill.customer_ref,
    items,
    subtotal: Number(bill.subtotal),
    cgstAmount: Number(bill.cgst_amount),
    sgstAmount: Number(bill.sgst_amount),
    roundingAdjustment: Number(bill.rounding_adjustment),
    totalAmount: Number(bill.total_amount),
    shopName: 'Abinaya Supermarket',
    shopAddress: 'Chennai, Tamil Nadu',
    shopGstin: '33ABCDE1234F1Z5',
  };
}

const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

export async function generateInvoicePDF(billId: string): Promise<Buffer> {
  const data = await fetchInvoiceData(billId);

  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 50,
      info: {
        Title: `Invoice ${data.invoiceNumber}`,
        Author: data.shopName,
      },
    });

    const chunks: Buffer[] = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const { width } = doc.page;
    const marginLeft = 50;
    const marginRight = width - 50;

    doc.fontSize(20).text(data.shopName, marginLeft, 50, { align: 'center' });
    doc.fontSize(12).text(data.shopAddress, marginLeft, 75, { align: 'center' });
    doc.fontSize(10).text(`GSTIN: ${data.shopGstin}`, marginLeft, 95, { align: 'center' });

    doc.moveDown(2);

    doc.fontSize(12).text(`Invoice: ${data.invoiceNumber}`, marginLeft, 130);
    doc.text(`Date: ${data.date}`, marginLeft, 145);
    doc.text(`Customer: ${data.customerRef || 'Cash'}`, marginLeft, 160);

    doc.moveDown(1);

    let y = 200;
    doc.fontSize(10).font('Helvetica-Bold');
    doc.text('Item', marginLeft, y, { width: 200 });
    doc.text('HSN', marginLeft + 200, y, { width: 80 });
    doc.text('Qty', marginLeft + 280, y, { width: 50 });
    doc.text('Price', marginLeft + 330, y, { width: 70 });
    doc.text('GST%', marginLeft + 400, y, { width: 50 });
    doc.text('Total', marginLeft + 450, y, { width: 70 });

    y += 20;
    doc.font('Helvetica');

    for (const item of data.items) {
      doc.text(item.productName, marginLeft, y, { width: 200 });
      doc.text(item.hsnCode, marginLeft + 200, y, { width: 80 });
      doc.text(String(item.quantity), marginLeft + 280, y, { width: 50 });
      doc.text(`₹${item.unitPrice}`, marginLeft + 330, y, { width: 70 });
      doc.text(`${item.gstRate}%`, marginLeft + 400, y, { width: 50 });
      doc.text(`₹${item.totalAmount}`, marginLeft + 450, y, { width: 70 });
      y += 20;
    }

    y += 10;

    doc.font('Helvetica-Bold');
    doc.text('Subtotal:', marginLeft + 350, y, { width: 100, align: 'right' });
    doc.text(`₹${data.subtotal}`, marginLeft + 450, y, { width: 70 });
    y += 18;

    doc.text('CGST:', marginLeft + 350, y, { width: 100, align: 'right' });
    doc.text(`₹${data.cgstAmount}`, marginLeft + 450, y, { width: 70 });
    y += 18;

    doc.text('SGST:', marginLeft + 350, y, { width: 100, align: 'right' });
    doc.text(`₹${data.sgstAmount}`, marginLeft + 450, y, { width: 70 });
    y += 18;

    if (Math.abs(data.roundingAdjustment) > 0.001) {
      doc.text('Rounding:', marginLeft + 350, y, { width: 100, align: 'right' });
      doc.text(`₹${data.roundingAdjustment}`, marginLeft + 450, y, { width: 70 });
      y += 18;
    }

    doc.fontSize(12);
    doc.text('Total:', marginLeft + 350, y, { width: 100, align: 'right' });
    doc.text(`₹${data.totalAmount}`, marginLeft + 450, y, { width: 70 });

    doc.moveDown(2);

    doc.fontSize(9).font('Helvetica').text(
      'This is a computer-generated invoice.',
      marginLeft,
      y + 20,
      { align: 'center' }
    );

    doc.end();
  });
}