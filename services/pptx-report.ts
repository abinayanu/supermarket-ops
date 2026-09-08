import pptxgen from 'pptxgenjs';
import { query } from './db';

interface SalesSummary {
  totalSales: number;
  totalGST: number;
  cashSales: number;
  upiSales: number;
  cardSales: number;
  topItems: Array<{
    name: string;
    quantity: number;
    revenue: number;
  }>;
  stockHealth: Array<{
    name: string;
    unit: string;
    currentStock: number;
    mrp: number;
  }>;
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

        COALESCE(
          SUM(
            COALESCE(cgst_amount, 0) +
            COALESCE(sgst_amount, 0)
          ),
          0
        ) AS total_gst,

        COALESCE(
          SUM(
            CASE
              WHEN payment_mode = 'CASH'
              THEN total_amount
              ELSE 0
            END
          ),
          0
        ) AS cash_sales,

        COALESCE(
          SUM(
            CASE
              WHEN payment_mode = 'UPI'
              THEN total_amount
              ELSE 0
            END
          ),
          0
        ) AS upi_sales,

        COALESCE(
          SUM(
            CASE
              WHEN payment_mode = 'CARD'
              THEN total_amount
              ELSE 0
            END
          ),
          0
        ) AS card_sales

      FROM bills

      WHERE status = 'finalized'
        AND finalized_at >= CURRENT_DATE - INTERVAL '6 days'
        AND finalized_at < CURRENT_DATE + INTERVAL '1 day';
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

      JOIN products p
        ON p.id = bi.product_id

      JOIN bills b
        ON b.id = bi.bill_id

      WHERE b.status = 'finalized'
        AND b.finalized_at >= CURRENT_DATE - INTERVAL '6 days'
        AND b.finalized_at < CURRENT_DATE + INTERVAL '1 day'
        AND bi.status = 'active'

      GROUP BY p.id, p.name

      ORDER BY revenue DESC

      LIMIT 5;
    `
  );

  const stockResult = await query<{
    name: string;
    unit: string;
    current_stock: string;
    mrp: string;
  }>(
    `
      SELECT
        name,
        unit,
        current_stock,
        mrp

      FROM products

      WHERE is_active = true

      ORDER BY current_stock ASC, name ASC

      LIMIT 8;
    `
  );

  const row = salesResult[0];

  return {
    totalSales: Number(row.total_sales),
    totalGST: Number(row.total_gst),
    cashSales: Number(row.cash_sales),
    upiSales: Number(row.upi_sales),
    cardSales: Number(row.card_sales),

    topItems: topItemsResult.map((item) => ({
      name: item.name,
      quantity: Number(item.quantity),
      revenue: Number(item.revenue)
    })),

    stockHealth: stockResult.map((item) => ({
      name: item.name,
      unit: item.unit,
      currentStock: Number(item.current_stock),
      mrp: Number(item.mrp)
    }))
  };
}

export async function generateWeeklySalesPPTX(): Promise<Buffer> {
  const summary = await getSalesSummary();

  const pres = new pptxgen();

  pres.layout = 'LAYOUT_WIDE';

  pres.author = 'Abinaya Supermarket';
  pres.subject = 'Weekly Sales Analysis';
  pres.title = 'Weekly Sales Analysis';
  pres.company = 'Abinaya Supermarket';

  /*
   * Slide 1
   * Weekly sales overview
   */
  const slide1 = pres.addSlide();

  slide1.addText('Weekly Sales Analysis', {
    x: 0.6,
    y: 0.4,
    w: 12,
    h: 0.6,
    fontSize: 28,
    bold: true
  });

  slide1.addText('Last 7 Days', {
    x: 0.6,
    y: 1.05,
    w: 12,
    h: 0.3,
    fontSize: 14
  });

  slide1.addText(
    `Total Sales\n₹${summary.totalSales.toFixed(2)}`,
    {
      x: 0.8,
      y: 1.8,
      w: 5.3,
      h: 1.0,
      fontSize: 24,
      bold: true,
      align: 'center',
      valign: 'middle'
    }
  );

  slide1.addText(
    `Total GST Collected\n₹${summary.totalGST.toFixed(2)}`,
    {
      x: 6.8,
      y: 1.8,
      w: 5.3,
      h: 1.0,
      fontSize: 24,
      bold: true,
      align: 'center',
      valign: 'middle'
    }
  );

  slide1.addText('Payment Split', {
    x: 0.8,
    y: 3.2,
    w: 4,
    h: 0.4,
    fontSize: 20,
    bold: true
  });

  slide1.addText(
    `Cash: ₹${summary.cashSales.toFixed(2)}`,
    {
      x: 0.8,
      y: 3.8,
      w: 4,
      h: 0.4,
      fontSize: 18
    }
  );

  slide1.addText(
    `UPI: ₹${summary.upiSales.toFixed(2)}`,
    {
      x: 0.8,
      y: 4.4,
      w: 4,
      h: 0.4,
      fontSize: 18
    }
  );

  slide1.addText(
    `Card: ₹${summary.cardSales.toFixed(2)}`,
    {
      x: 0.8,
      y: 5.0,
      w: 4,
      h: 0.4,
      fontSize: 18
    }
  );

  /*
   * Real payment chart
   */
  slide1.addChart(
    "bar",
    [
      {
        name: 'Sales',
        labels: ['Cash', 'UPI', 'Card'],
        values: [
          summary.cashSales,
          summary.upiSales,
          summary.cardSales
        ]
      }
    ],
    {
      x: 5.0,
      y: 3.1,
      w: 7.0,
      h: 3.0,
      showTitle: true,
      title: 'Payment Mode Sales',
      showLegend: false,
      showValue: true,
      catAxisLabelFontSize: 12,
      valAxisLabelFontSize: 10
    }
  );

  /*
   * Slide 2
   * Top selling items
   */
  const slide2 = pres.addSlide();

  slide2.addText('Top Selling Items', {
    x: 0.6,
    y: 0.4,
    w: 12,
    h: 0.6,
    fontSize: 28,
    bold: true
  });

  if (summary.topItems.length === 0) {
    slide2.addText(
      'No sales recorded in the last 7 days.',
      {
        x: 0.8,
        y: 2.0,
        w: 10,
        h: 0.5,
        fontSize: 20
      }
    );
  } else {
    summary.topItems.forEach((item, index) => {
      slide2.addText(
        `${index + 1}. ${item.name}`,
        {
          x: 0.8,
          y: 1.4 + index * 0.75,
          w: 5,
          h: 0.4,
          fontSize: 18,
          bold: true
        }
      );

      slide2.addText(
        `${item.quantity} units`,
        {
          x: 6.0,
          y: 1.4 + index * 0.75,
          w: 2.5,
          h: 0.4,
          fontSize: 18
        }
      );

      slide2.addText(
        `₹${item.revenue.toFixed(2)}`,
        {
          x: 9.0,
          y: 1.4 + index * 0.75,
          w: 2.5,
          h: 0.4,
          fontSize: 18
        }
      );
    });

    /*
     * Real top-items revenue chart
     */
    slide2.addChart(
      "bar",
      [
        {
          name: 'Revenue',
          labels: summary.topItems.map(
            (item) => item.name
          ),
          values: summary.topItems.map(
            (item) => item.revenue
          )
        }
      ],
      {
        x: 0.8,
        y: 5.0,
        w: 11.0,
        h: 1.8,
        showTitle: true,
        title: 'Top Items by Revenue',
        showLegend: false,
        showValue: true,
        catAxisLabelFontSize: 10,
        valAxisLabelFontSize: 10
      }
    );
  }

  /*
   * Slide 3
   * Stock health
   */
  const slide3 = pres.addSlide();

  slide3.addText('Stock Health', {
    x: 0.6,
    y: 0.4,
    w: 12,
    h: 0.6,
    fontSize: 28,
    bold: true
  });

  slide3.addText(
    'Products ordered from lowest stock to highest stock',
    {
      x: 0.6,
      y: 1.0,
      w: 12,
      h: 0.3,
      fontSize: 14
    }
  );

  summary.stockHealth.forEach((item, index) => {
    const y = 1.5 + index * 0.55;

    slide3.addText(item.name, {
      x: 0.7,
      y,
      w: 4.4,
      h: 0.3,
      fontSize: 14,
      bold: index < 2
    });

    slide3.addText(item.unit, {
      x: 5.1,
      y,
      w: 1.3,
      h: 0.3,
      fontSize: 13
    });

    slide3.addText(
      `${item.currentStock}`,
      {
        x: 6.5,
        y,
        w: 1.5,
        h: 0.3,
        fontSize: 14,
        bold: true
      }
    );

    slide3.addText(
      `₹${item.mrp.toFixed(2)}`,
      {
        x: 8.2,
        y,
        w: 1.8,
        h: 0.3,
        fontSize: 14
      }
    );

    const status =
      item.currentStock <= 10
        ? 'LOW STOCK'
        : 'OK';

    slide3.addText(status, {
      x: 10.0,
      y,
      w: 2.0,
      h: 0.3,
      fontSize: 12,
      bold: true
    });
  });

  slide3.addText('Product', {
    x: 0.7,
    y: 1.15,
    w: 4.4,
    h: 0.3,
    fontSize: 12,
    bold: true
  });

  slide3.addText('Unit', {
    x: 5.1,
    y: 1.15,
    w: 1.3,
    h: 0.3,
    fontSize: 12,
    bold: true
  });

  slide3.addText('Stock', {
    x: 6.5,
    y: 1.15,
    w: 1.5,
    h: 0.3,
    fontSize: 12,
    bold: true
  });

  slide3.addText('MRP', {
    x: 8.2,
    y: 1.15,
    w: 1.8,
    h: 0.3,
    fontSize: 12,
    bold: true
  });

  slide3.addText('Status', {
    x: 10.0,
    y: 1.15,
    w: 2.0,
    h: 0.3,
    fontSize: 12,
    bold: true
  });

  /*
   * Real stock chart
   */
  slide3.addChart(
    "bar",
    [
      {
        name: 'Current Stock',
        labels: summary.stockHealth.map(
          (item) => item.name
        ),
        values: summary.stockHealth.map(
          (item) => item.currentStock
        )
      }
    ],
    {
      x: 0.8,
      y: 6.0,
      w: 11.0,
      h: 1.2,
      showTitle: true,
      title: 'Current Stock Levels',
      showLegend: false,
      showValue: true,
      catAxisLabelFontSize: 8,
      valAxisLabelFontSize: 8
    }
  );

  return await pres.write({
    outputType: 'nodebuffer'
  }) as Buffer;
}