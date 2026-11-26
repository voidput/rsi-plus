/**
 * Hulls RSI's upgrade catalog (`initShipUpgrade`) never lists — sold only as rare standalone / event packages, never
 * as a CCU target — so the planner and catalog would not know them. MSRPs are their pledge cost on starcitizen.tools
 * (checked 2026-10-16; the Star Citizen Wiki API agrees for Javelin and Idris-M and has no price for the Kraken).
 * The Odin (2026-11) is a $5,000 limited concept pledge sold through the Odin Founders Club, not the store.
 * The F7A Hornet Mk II was a limited upgrade from the F7C Mk II ($175 on starcitizen.tools, 2026-11-25): without it a
 * hangar F7A matched the F7C Mk II. Both take the same Hornet Mk II paints (`paintLine` → hornet).
 * The F8C Lightning ($300 standalone, $260 warbond on starcitizen.tools, 2026-11-25) is sold only to Wing Commanders and
 * gold-license holders in time-limited sales; its Executive Edition (a reward, no pledge price) matches it by name.
 * Ids are negative so they never collide with RSI's; `fetchCatalog` adds one only when RSI doesn't list that name.
 */
import type { CatalogShip } from '../store';

const extra = (id: number, name: string, manufacturer: string, focus: string, usd: number, flyable: string): CatalogShip => ({
  id,
  name,
  manufacturer,
  focus,
  msrp: usd * 100,
  flyable,
  link: `https://starcitizen.tools/${name.replace(/ /g, '_')}`,
  thumb: null,
  standalone: [],
  ccu: [],
  msrpSource: 'wiki',
});

export const EXTRA_SHIPS: CatalogShip[] = [
  extra(-9001, 'Kraken', 'Drake Interplanetary', 'Light Carrier', 1650, 'Concept'),
  extra(-9002, 'Kraken Privateer', 'Drake Interplanetary', 'Light Carrier', 2420, 'Concept'),
  extra(-9003, 'Javelin', 'Aegis Dynamics', 'Destroyer', 3000, 'Concept'),
  extra(-9004, 'Idris-M', 'Aegis Dynamics', 'Frigate', 1000, 'Flight Ready'),
  extra(-9005, 'Odin', 'Anvil Aerospace', 'Battlecruiser', 5000, 'Concept'),
  extra(-9006, 'F7A Hornet Mk II', 'Anvil Aerospace', 'Medium Fighter', 175, 'Flight Ready'),
  extra(-9007, 'F8C Lightning', 'Anvil Aerospace', 'Heavy Fighter', 300, 'Flight Ready'),
];
