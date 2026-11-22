// The colours you hunt for, in four tiers of difficulty. Shared with the server,
// which picks each match's colours so every phone gets the same ones.
//
// The values are what real things look like through a phone camera indoors,
// not screen primaries: nothing in a living room photographs as #00ff00.
// Tier 1 is everyday stuff (ketchup, jeans, a houseplant); tier 4 is the muted,
// in-between shades that make people run from room to room.

import { hexToLab, deltaE00 } from "./color.js";

const RAW = [
  // tier 1: bold, everyday
  [1, "Ketchup", "#b3302c"],
  [1, "Traffic Cone", "#e8662a"],
  [1, "Banana", "#e6c84a"],
  [1, "Houseplant", "#4f8a3c"],
  [1, "Blue Jeans", "#3e5f8a"],
  [1, "Cardboard", "#b08a5e"],
  [1, "Bubblegum", "#e78bb0"],
  [1, "Clear Sky", "#79aee0"],
  [1, "Grape Soda", "#6b3f8e"],
  [1, "Chocolate", "#6a412b"],

  // tier 2: common, but you have to look
  [2, "Teal", "#23807f"],
  [2, "Lime", "#a3c43c"],
  [2, "Navy", "#324a78"],
  [2, "Wine", "#7b2b3a"],
  [2, "Mustard", "#caa12c"],
  [2, "Coral", "#ea7a63"],
  [2, "Mint", "#93d2b4"],
  [2, "Pool Toy", "#36b3c4"],
  [2, "Lavender", "#a698d4"],
  [2, "Olive", "#7d7a32"],
  [2, "Peach", "#f1b38c"],
  [2, "Egg Yolk", "#eeb02e"],
  [2, "Forest", "#2f5d3f"],
  [2, "Hot Pink", "#d64a8a"],
  [2, "Cobalt", "#2c5cc5"],
  [2, "Rust", "#a64a2a"],

  // tier 3: a particular shade
  [3, "Salmon", "#e59780"],
  [3, "Plum", "#85467f"],
  [3, "Ochre", "#c48a2e"],
  [3, "Sage", "#93a58c"],
  [3, "Periwinkle", "#8d9de0"],
  [3, "Magenta", "#b83a7c"],
  [3, "Apricot", "#f0a65f"],
  [3, "Cherry", "#a3263d"],
  [3, "Terracotta", "#c26a4c"],
  [3, "Indigo", "#41418c"],
  [3, "Jade", "#3a9a6e"],
  [3, "Lilac", "#c3a3cf"],
  [3, "Faded Denim", "#6f8db3"],
  [3, "Turquoise", "#1aa89c"],
  [3, "Spring Green", "#78c068"],

  // tier 4: muted, in-between, tricky
  [4, "Mauve", "#ad7d9c"],
  [4, "Dusty Rose", "#c48f8f"],
  [4, "Khaki", "#b5a675"],
  [4, "Mulberry", "#7a3e5c"],
  [4, "Steel Teal", "#5e8a8c"],
  [4, "Pistachio", "#aac58e"],
  [4, "Eggplant", "#613b5f"],
  [4, "Blush", "#e2a7a5"],
  [4, "Sand", "#d1b88c"],
  [4, "Raspberry", "#b3355f"],
  [4, "Clay", "#a8735a"],
  [4, "Sea Glass", "#8fb8a8"],
  [4, "Lichen", "#9aa06e"],
  [4, "Petrol", "#36606b"],
  [4, "Orchid", "#b062b8"],
  [4, "Iris", "#5d5fae"],
  [4, "Rosewood", "#8a4f4a"],
];

// Neutrals are never targets, but they name what people actually point at.
const NEUTRALS = [
  ["Snow", "#f2f2ef"],
  ["Chalk", "#d9d7d2"],
  ["Oatmeal", "#d6c9b1"],
  ["Concrete", "#a5a39f"],
  ["Mushroom", "#9b8b7b"],
  ["Pebble", "#7c7a76"],
  ["Charcoal", "#45464a"],
  ["Soot", "#1f1f22"],
];

export const PALETTE = RAW.map(([tier, name, hex], i) => ({ id: i, tier, name, hex, lab: hexToLab(hex) }));
const NAMING = PALETTE.concat(NEUTRALS.map(([name, hex]) => ({ tier: 0, name, hex, lab: hexToLab(hex) })));

// Tier for each round of an n-round match: easy first, hardest last.
export function tiersFor(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(n === 1 ? 2 : Math.round(1 + (3 * i) / (n - 1)));
  return out;
}

// Pick one colour per tier from a seeded random source. Consecutive colours are
// kept far apart, and nothing repeats in a match.
export function pickTargets(rand, tiers) {
  const used = [];
  for (const tier of tiers) {
    const pool = PALETTE.filter((p) => p.tier === tier && !used.includes(p));
    const prev = used[used.length - 1];
    const tries = [
      (p) => (!prev || deltaE00(prev.lab, p.lab) >= 28) && used.every((u) => deltaE00(u.lab, p.lab) >= 16),
      (p) => !prev || deltaE00(prev.lab, p.lab) >= 18,
      () => true,
    ];
    let pick = null;
    for (const ok of tries) {
      const c = pool.filter(ok);
      if (c.length) { pick = c[Math.floor(rand() * c.length)]; break; }
    }
    if (!pick) pick = PALETTE[Math.floor(rand() * PALETTE.length)];
    used.push(pick);
  }
  return used;
}

// The closest named colour, for "looks like Rust" on the reveal.
export function nameOf(lab) {
  let best = NAMING[0];
  let bd = Infinity;
  for (const p of NAMING) {
    const d = deltaE00(lab, p.lab);
    if (d < bd) { bd = d; best = p; }
  }
  return best.name;
}

export function byName(name) {
  return PALETTE.find((p) => p.name === name) || null;
}

// Seeded PRNG so the server (and the daily palette) can reproduce a match.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
