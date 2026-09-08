export interface GSTResult {
  cgstPaise: number;
  sgstPaise: number;
  totalGSTPaise: number;
}

export function calculateGST(amountPaise: number, gstSlabPercent: number): GSTResult {
  const totalGSTPaise = Math.round((amountPaise * gstSlabPercent) / 100);
  const cgstPaise = Math.round(totalGSTPaise / 2);
  const sgstPaise = totalGSTPaise - cgstPaise;
  
  return { cgstPaise, sgstPaise, totalGSTPaise };
}

export function applyRounding(amountPaise: number, rule: 'nearest_5' | 'nearest_10' | 'none'): number {
  if (rule === 'none') return amountPaise;
  const divisor = rule === 'nearest_5' ? 5 : 10;
  return Math.round(amountPaise / divisor) * divisor;
}
