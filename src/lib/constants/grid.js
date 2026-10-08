// Grid and region split of the simulated Earth (equirectangular, wraps in longitude).
export const W = 384, H = 192;          // grid (lon × lat), 0.94° per cell
export const RX = 6, RY = 4;            // region split
export const RW = W / RX, RH = H / RY;  // 64 × 48 cells
export const NREG = RX * RY;
export const STEPS = 240;               // seasons simulated per work unit
export const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX', 'XX', 'XXI', 'XXII', 'XXIII', 'XXIV'];
