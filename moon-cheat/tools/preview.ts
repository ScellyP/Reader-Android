// Run: npx tsx tools/preview.ts  -> writes preview.svg (open in a browser)
import { writeFileSync } from "fs";
import { MOON_PHASES, moonLitPath } from "../src/moonPhase";
import { generateGlass, crackLayers } from "../src/cracks";

const W = 390, H = 844;
const sys = generateGlass(W, H, 20261010);
const fw = 130, fh = Math.round(fw * H / W);
let out = "", y = 170;

MOON_PHASES.forEach((name, k) => {
  const cx = 70 + k * 130, cy = 70, r = 45;
  out += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#2a2a36" stroke="#f3efe0" stroke-opacity=".35"/>`;
  if (k) out += `<path d="${moonLitPath(k, cx, cy, r)}" fill="#f3efe0"/>`;
  out += `<text x="${cx}" y="${cy + 70}" fill="#ddd" font-size="12" text-anchor="middle" font-family="sans-serif">${k} ${name}</text>`;
});

const frames = [0.05, 0.2, 0.4, 0.6, 0.8, 0.92, 1];
for (const dark of [true, false]) {
  const bg = dark ? "#0b0b10" : "#f6f4ee", inv = dark ? "#fff" : "#000", base = dark ? "#000" : "#fff";
  frames.forEach((p, i) => {
    const q = Math.round(p * 120) / 120, L = crackLayers(sys, q), s = L.scale;
    out += `<svg x="${10 + i * 148}" y="${y}" width="${fw}" height="${fh}" viewBox="0 0 ${W} ${H}">`;
    out += `<defs><radialGradient id="pool${dark ? "d" : "l"}${i}"><stop offset="0" stop-color="${inv}" stop-opacity="1"/><stop offset=".55" stop-color="${inv}" stop-opacity=".8"/><stop offset="1" stop-color="${inv}" stop-opacity="0"/></radialGradient></defs>`;
    out += `<rect width="${W}" height="${H}" fill="${bg}"/><circle cx="${W / 2}" cy="${H / 2}" r="50" fill="${dark ? "#f3efe0" : "#1c1c28"}"/>`;
    for (const o of L.pools) out += `<circle cx="${o.cx}" cy="${o.cy}" r="${o.r}" fill="url(#pool${dark ? "d" : "l"}${i})" opacity="${o.alpha}"/>`;
    if (L.fillOpacity) out += `<rect width="${W}" height="${H}" fill="${inv}" opacity="${L.fillOpacity}"/>`;
    const st = (c: string, w: number, o: number) => `<path d="${L.lines}" stroke="${c}" stroke-width="${w}" stroke-opacity="${o}" fill="none" stroke-linecap="round"/>`;
    out += st(inv, 7 * s, .1) + st(inv, 2.6 * s, .45) + st(inv, 1.2 * s, .95);
    out += `<path d="${L.shards}" fill="${inv}" fill-opacity=".45"/><path d="${L.scratches}" stroke="${inv}" stroke-width=".6" stroke-opacity=".3" fill="none"/>`;
    out += st(base, .9 * s, L.coreOpacity) + `<path d="${L.shards}" fill="${base}" fill-opacity="${.5 * L.coreOpacity}"/><path d="${L.scratches}" stroke="${base}" stroke-width=".6" stroke-opacity="${.5 * L.coreOpacity}" fill="none"/>`;
    out += `<rect width="${W}" height="${H}" fill="none" stroke="#888" stroke-width="3"/></svg>`;
    out += `<text x="${10 + i * 148 + fw / 2}" y="${y + fh + 14}" fill="#ddd" font-size="12" text-anchor="middle" font-family="sans-serif">${dark ? "dark" : "light"} p=${p}</text>`;
  });
  y += fh + 30;
}
writeFileSync("preview.svg", `<svg xmlns="http://www.w3.org/2000/svg" width="1060" height="${y}"><rect width="100%" height="100%" fill="#333"/>${out}</svg>`);
console.log("wrote preview.svg");
