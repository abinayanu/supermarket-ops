const pptx = require('pptx');
import { query } from './db';

interface SalesSummary {
  totalSales: number;
  totalGST: number;
  cashSales: number;
  upiSales: number;
  cardSales: number;
  topItems: Array<{ name: string; quantity: number; revenue: number }>;
}

async function getSalesSummary(): Promise<SalesSummary> {
  const salesResult = await query<{
    total_sales: string;
    total_gst: string;
    cash_sales: string;
    upi_sales: string;
    card_sales: string;
  }>(
    `
      SELECT
        COALESCE(SUM(total_amount), 0) AS total_sales,
        COALESCE(SUM(cgst_amount + sgst_amount), 0) AS total_gst,
        COALESCE(SUM(CASE WHEN payment_mode = 'cash' THEN total_amount ELSE 0 END), 0) AS cash_sales,
        COALESCE(SUM(CASE WHEN payment_mode = 'upi' THEN total_amount ELSE 0 END), 0) AS upi_sales,
        COALESCE(SUM(CASE WHEN payment_mode = 'card' THEN total_amount ELSE 0 END), 0) AS card_sales
      FROM bills
      WHERE status = 'finalized'
        AND finalized_at >= date_trunc('day', now());
    `
  );

  const topItemsResult = await query<{
    name: string;
    quantity: string;
    revenue: string;
  }>(
    `
      SELECT
        p.name,
        SUM(bi.quantity) AS quantity,
        SUM(bi.line_subtotal) AS revenue
      FROM bill_items bi
      JOIN products p ON p.id = bi.product_id
      JOIN bills b ON b.id = bi.bill_id
      WHERE b.status = 'finalized'
        AND b.finalized_at >= date_trunc('day', now())
        AND bi.status = 'active'
      GROUP BY p.id, p.name
      ORDER BY revenue DESC
      LIMIT 5;
    `
  );

  return {
    totalSales: Number(salesResult[0].total_sales),
    totalGST: Number(salesResult[0].total_gst),
    cashSales: Number(salesResult[0].cash_sales),
    upiSales: Number(salesResult[0].upi_sales),
    cardSales: Number(salesResult[0].card_sales),
    topItems: topItemsResult.map((row) => ({
      name: row.name,
      quantity: Number(row.quantity),
      revenue: Number(row.revenue)
    }))
  };
}

export async function generateWeeklySalesPPTX(): Promise<Buffer> {
  const summary = await getSalesSummary();

  const pres = new pptx();

  // Slide 1: Title
  pres.addSlide({
    title: 'Weekly Sales Analysis',
    content: [
      { text: `Total Sales: ₹${summary.totalSales.toFixed(2)}`, options: { fontSize: 24 } },
      { text: `Total GST: ₹${summary.totalGST.toFixed(2)}`, options: { fontSize: 24 } },
      { text: '', options: {} },
      { text: 'Payment Split:', options: { fontSize: 20, bold: true } },
      { text: `  Cash: ₹${summary.cashSales.toFixed(2)}`, options: { fontSize: 18 } },
      { text: `  UPI: ₹${summary.upiSales.toFixed(2)}`, options: { fontSize: 18 } },
      { text: `  Card: ₹${summary.cardSales.toFixed(2)}`, options: { fontSize: 18 } }
    ]
  });

  // Slide 2: Top Items
  pres.addSlide({
    title: 'Top Selling Items',
    content: summary.topItems.map((item, idx) => ({
      text: `${idx + 1}. ${item.name} - ${item.quantity} units (₹${item.revenue.toFixed(2)})`,
      options: { fontSize: 18 }
    }))
  });

  return pres.write('buffer');
}