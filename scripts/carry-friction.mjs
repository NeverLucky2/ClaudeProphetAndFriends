// One completed IEF hold = buy + sell = round trip = 2 * half-spread. Charged once on the exit
// day of each hold episode (see carry-sim). stressMult scales worst-case fills.
import { FRICTION_HALF_SPREAD_BPS } from './carry-universe.mjs';

export function roundTripCost(stressMult = 1) {
  return 2 * (FRICTION_HALF_SPREAD_BPS / 10000) * stressMult;
}
