/**
 * Generates a simple, original floor plan (SVG) for the demo data. Desk markers are drawn by the web app
 * on top of the image, using the normalised coordinates stored on each desk.
 */
export interface PlanRoom {
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PlanDesk {
  x: number; // 0..1
  y: number; // 0..1
}

export const PLAN_W = 1000;
export const PLAN_H = 600;

export function floorPlanSvg(title: string, rooms: PlanRoom[], desks: PlanDesk[]): string {
  const deskRects = desks
    .map((d) => {
      const cx = d.x * PLAN_W;
      const cy = d.y * PLAN_H;
      return `<rect x="${(cx - 26).toFixed(1)}" y="${(cy - 16).toFixed(1)}" width="52" height="32" rx="4" fill="#e9eef5" stroke="#b8c4d3" />`;
    })
    .join('');
  const roomRects = rooms
    .map(
      (r) =>
        `<g><rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="#f6f2ea" stroke="#8a8173" stroke-width="3" />` +
        `<text x="${r.x + r.w / 2}" y="${r.y + r.h / 2}" text-anchor="middle" dominant-baseline="middle" font-family="sans-serif" font-size="20" fill="#4b4438">${escapeXml(r.label)}</text></g>`,
    )
    .join('');
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PLAN_W} ${PLAN_H}" width="${PLAN_W}" height="${PLAN_H}" role="img" aria-label="${escapeXml(title)}">`,
    `<rect x="0" y="0" width="${PLAN_W}" height="${PLAN_H}" fill="#ffffff" />`,
    `<rect x="10" y="10" width="${PLAN_W - 20}" height="${PLAN_H - 20}" fill="#fbfbfa" stroke="#4b4438" stroke-width="6" />`,
    `<rect x="440" y="${PLAN_H - 16}" width="120" height="12" fill="#fbfbfa" />`,
    `<text x="500" y="${PLAN_H - 24}" text-anchor="middle" font-family="sans-serif" font-size="16" fill="#6b6457">Ingresso</text>`,
    roomRects,
    deskRects,
    `<text x="30" y="44" font-family="sans-serif" font-size="22" font-weight="bold" fill="#4b4438">${escapeXml(title)}</text>`,
    '</svg>',
  ].join('');
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);
}
