import { calculateGST, applyRounding } from '../services/pricing.service';

console.log('Testing GST calculation...');
const gst = calculateGST(10000, 18);
console.log('GST result:', gst);

console.log('Testing rounding...');
const rounded = applyRounding(123, 'nearest_5');
console.log('Rounded:', rounded);
