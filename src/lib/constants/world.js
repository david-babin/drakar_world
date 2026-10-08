// World bookkeeping: leases, freezes, chronicle.
export const LEASE_MS = 90_000;              // a leased region returns to the pool after this
export const FREEZE_MS = 6 * 3600_000;       // a gap without witnesses longer than this is written in the chronicle
export const ID_BLOCK = 4000;                // ids reserved per unit for new groups and settlements
export const NEIGHBOURHOOD = 80;             // cells around a region whose settlements and routes travel with a unit
export const CHRONICLE_KEEP = 400;           // entries kept in the world state
export const CHRONICLE_SNAPSHOT = 40;        // entries sent to a new visitor
export const FOUND_PER_UNIT = 3;             // foundings kept in the chronicle per unit
// chronicle kinds kept at most once per unit
export const ONE_PER_UNIT = ['raid', 'voyage', 'route', 'crossing', 'assimilate', 'revolt', 'takeover', 'abandon'];
// new lineage groups (genesis, rebirth)
export const LANDING = { pop: 42, food: 260 };
