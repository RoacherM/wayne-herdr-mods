/**
 * Program and status icons matching Herdr.app's sidebar (mods/agents & icons/).
 * Picture icons (tint: false) render as <img> data URIs so SVG filter/mask IDs never collide;
 * monochrome glyphs (tint: true) render inline with currentColor.
 */

const SHELLS = new Set(['zsh', 'bash', 'fish', 'sh', 'dash', 'nu', 'pwsh', 'powershell', 'cmd', 'elvish', 'xonsh', 'tcsh', 'csh', 'ksh', 'ion']);
const ALIASES = { 'claude-code': 'claude', agy: 'antigravity', 'cursor-agent': 'cursor' };

const BUILTIN = {
  claude: {
    tint: false,
    svg: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path clip-rule="evenodd" d="M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z" fill="#D97757" fill-rule="evenodd"/></svg>',
  },
  antigravity: {
    tint: false,
    svg: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><mask height="23" id="ag-m" maskUnits="userSpaceOnUse" width="24" x="0" y="1"><path d="M21.751 22.607c1.34 1.005 3.35.335 1.508-1.508C17.73 15.74 18.904 1 12.037 1 5.17 1 6.342 15.74.815 21.1c-2.01 2.009.167 2.511 1.507 1.506 5.192-3.517 4.857-9.714 9.715-9.714 4.857 0 4.522 6.197 9.714 9.715z" fill="#fff"/></mask><g mask="url(#ag-m)"><g filter="url(#ag-1)"><path d="M-1.018-3.992c-.408 3.591 2.686 6.89 6.91 7.37 4.225.48 7.98-2.043 8.387-5.633.408-3.59-2.686-6.89-6.91-7.37-4.225-.479-7.98 2.043-8.387 5.633z" fill="#FFE432"/></g><g filter="url(#ag-2)"><path d="M15.269 7.747c1.058 4.557 5.691 7.374 10.348 6.293 4.657-1.082 7.575-5.653 6.516-10.21-1.058-4.556-5.691-7.374-10.348-6.292-4.657 1.082-7.575 5.653-6.516 10.21z" fill="#FC413D"/></g><g filter="url(#ag-3)"><path d="M-12.443 10.804c1.338 4.703 7.36 7.11 13.453 5.378 6.092-1.733 9.947-6.95 8.61-11.652C8.282-.173 2.26-2.58-3.833-.848-9.925.884-13.78 6.1-12.443 10.804z" fill="#00B95C"/></g><g filter="url(#ag-5)"><path d="M-7.608 14.703c3.352 3.424 9.126 3.208 12.896-.483 3.77-3.69 4.108-9.459.756-12.883C2.69-2.087-3.083-1.871-6.853 1.82c-3.77 3.69-4.108 9.458-.755 12.883z" fill="#00B95C"/></g><g filter="url(#ag-6)"><path d="M9.932 27.617c1.04 4.482 5.384 7.303 9.7 6.3 4.316-1.002 6.971-5.448 5.93-9.93-1.04-4.483-5.384-7.304-9.7-6.301-4.316 1.002-6.971 5.448-5.93 9.93z" fill="#3186FF"/></g><g filter="url(#ag-7)"><path d="M2.572-8.185C.392-3.329 2.778 2.472 7.9 4.771c5.122 2.3 11.042.227 13.222-4.63 2.18-4.855-.205-10.656-5.327-12.955-5.122-2.3-11.042-.227-13.222 4.63z" fill="#FBBC04"/></g><g filter="url(#ag-8)"><path d="M-3.267 38.686c-5.277-2.072 3.742-19.117 5.984-24.83 2.243-5.712 8.34-8.664 13.616-6.592 5.278 2.071 11.533 13.482 9.29 19.195-2.242 5.713-23.613 14.298-28.89 12.227z" fill="#3186FF"/></g><g filter="url(#ag-9)"><path d="M28.71 17.471c-1.413 1.649-5.1.808-8.236-1.878-3.135-2.687-4.531-6.201-3.118-7.85 1.412-1.649 5.1-.808 8.235 1.878s4.532 6.2 3.119 7.85z" fill="#749BFF"/></g><g filter="url(#ag-10)"><path d="M18.163 9.077c5.81 3.93 12.502 4.19 14.946.577 2.443-3.612-.287-9.727-6.098-13.658-5.81-3.931-12.502-4.19-14.946-.577-2.443 3.612.287 9.727 6.098 13.658z" fill="#FC413D"/></g><g filter="url(#ag-11)"><path d="M-.915 2.684c-1.44 3.473-.97 6.967 1.05 7.804 2.02.837 4.824-1.3 6.264-4.772 1.44-3.473.97-6.967-1.05-7.804-2.02-.837-4.824 1.3-6.264 4.772z" fill="#FFEE48"/></g></g><defs><filter color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse" height="17.587" id="ag-1" width="19.838" x="-3.288" y="-11.917"><feGaussianBlur stdDeviation="1.117"/></filter><filter color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse" height="38.565" id="ag-2" width="38.9" x="4.251" y="-13.493"><feGaussianBlur stdDeviation="5.4"/></filter><filter color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse" height="36.517" id="ag-3" width="40.955" x="-21.889" y="-10.592"><feGaussianBlur stdDeviation="4.591"/></filter><filter color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse" height="36.595" id="ag-5" width="36.632" x="-19.099" y="-10.278"><feGaussianBlur stdDeviation="4.591"/></filter><filter color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse" height="34.087" id="ag-6" width="33.533" x=".981" y="8.758"><feGaussianBlur stdDeviation="4.363"/></filter><filter color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse" height="35.276" id="ag-7" width="35.978" x="-6.143" y="-21.659"><feGaussianBlur stdDeviation="3.954"/></filter><filter color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse" height="46.523" id="ag-8" width="45.114" x="-11.96" y="-.46"><feGaussianBlur stdDeviation="3.531"/></filter><filter color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse" height="24.054" id="ag-9" width="25.094" x="10.485" y=".58"><feGaussianBlur stdDeviation="3.159"/></filter><filter color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse" height="30.007" id="ag-10" width="33.508" x="5.833" y="-12.467"><feGaussianBlur stdDeviation="2.669"/></filter><filter color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse" height="26.151" id="ag-11" width="22.194" x="-8.355" y="-8.876"><feGaussianBlur stdDeviation="3.303"/></filter></defs></svg>',
  },
  epi: {
    tint: false,
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 14 12"><rect x="0" y="0" width="14" height="2" fill="#b49ef0"/><rect x="0" y="4" width="14" height="2" fill="#86a8f6"/><rect x="2" y="6" width="2" height="6" fill="#86a8f6"/><rect x="10" y="6" width="2" height="6" fill="#86a8f6"/></svg>',
  },
  codex: {
    tint: false,
    svg: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M19.503 0H4.496A4.496 4.496 0 000 4.496v15.007A4.496 4.496 0 004.496 24h15.007A4.496 4.496 0 0024 19.503V4.496A4.496 4.496 0 0019.503 0z" fill="#fff"/><path d="M9.064 3.344a4.578 4.578 0 012.285-.312c1 .115 1.891.54 2.673 1.275.01.01.024.017.037.021a.09.09 0 00.043 0 4.55 4.55 0 013.046.275l.047.022.116.057a4.581 4.581 0 012.188 2.399c.209.51.313 1.041.315 1.595a4.24 4.24 0 01-.134 1.223.123.123 0 00.03.115c.594.607.988 1.33 1.183 2.17.289 1.425-.007 2.71-.887 3.854l-.136.166a4.548 4.548 0 01-2.201 1.388.123.123 0 00-.081.076c-.191.551-.383 1.023-.74 1.494-.9 1.187-2.222 1.846-3.711 1.838-1.187-.006-2.239-.44-3.157-1.302a.107.107 0 00-.105-.024c-.388.125-.78.143-1.204.138a4.441 4.441 0 01-1.945-.466 4.544 4.544 0 01-1.61-1.335c-.152-.202-.303-.392-.414-.617a5.81 5.81 0 01-.37-.961 4.582 4.582 0 01-.014-2.298.124.124 0 00.006-.056.085.085 0 00-.027-.048 4.467 4.467 0 01-1.034-1.651 3.896 3.896 0 01-.251-1.192 5.189 5.189 0 01.141-1.6c.337-1.112.982-1.985 1.933-2.618.212-.141.413-.251.601-.33.215-.089.43-.164.646-.227a.098.098 0 00.065-.066 4.51 4.51 0 01.829-1.615 4.535 4.535 0 011.837-1.388zm3.482 10.565a.637.637 0 000 1.272h3.636a.637.637 0 100-1.272h-3.636zM8.462 9.23a.637.637 0 00-1.106.631l1.272 2.224-1.266 2.136a.636.636 0 101.095.649l1.454-2.455a.636.636 0 00.005-.64L8.462 9.23z" fill="url(#cx-g)"/><defs><linearGradient gradientUnits="userSpaceOnUse" id="cx-g" x1="12" x2="12" y1="3" y2="21"><stop stop-color="#B1A7FF"/><stop offset=".5" stop-color="#7A9DFF"/><stop offset="1" stop-color="#3941FF"/></linearGradient></defs></svg>',
  },
  cursor: {
    tint: true,
    svg: '<svg fill="currentColor" fill-rule="evenodd" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M22.106 5.68L12.5.135a.998.998 0 00-.998 0L1.893 5.68a.84.84 0 00-.419.726v11.186c0 .3.16.577.42.727l9.607 5.547a.999.999 0 00.998 0l9.608-5.547a.84.84 0 00.42-.727V6.407a.84.84 0 00-.42-.726zm-.603 1.176L12.228 22.92c-.063.108-.228.064-.228-.061V12.34a.59.59 0 00-.295-.51l-9.11-5.26c-.107-.062-.063-.228.062-.228h18.55c.264 0 .428.286.296.514z"/></svg>',
  },
  gemini: {
    tint: true,
    svg: '<svg fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81"/></svg>',
  },
  pi: {
    tint: true,
    svg: '<svg fill="currentColor" viewBox="0 0 800 800" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z"/><path d="M517.36 400H634.72V634.72H517.36Z"/></svg>',
  },
  shell: {
    tint: true,
    svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><path d="M12 19h8"/><path d="m4 17 6-6-6-6"/></svg>',
  },
  agent: {
    tint: true,
    svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg>',
  },
  program: {
    tint: true,
    svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><path d="m7 11 2-2-2-2"/><path d="M11 13h4"/><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/></svg>',
  },
};

const SPINNER_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"><circle cx="12" cy="12" r="9.4" stroke-opacity="0.24"/><path d="M12 2.6a9.4 9.4 0 0 1 9.4 9.4"/></svg>';

function rawName(t) {
  if (!t) return '';
  return String(t.app || t.program || '').toLowerCase();
}

function resolveKey(t) {
  if (t?.icon) return t.icon;
  const raw = rawName(t);
  if (!raw || SHELLS.has(raw)) return 'shell';
  return ALIASES[raw] ?? raw;
}

function normalizeTintedSvg(svg) {
  const cleaned = svg.replace(/<\?xml[^>]*\?>\s*/i, '').replace(/fill="#(?:fff|ffffff|000|000000)"/gi, 'fill="currentColor"');
  if (!/fill=|stroke=/i.test(cleaned)) return cleaned.replace(/^<svg\b/i, '<svg fill="currentColor"');
  return cleaned;
}

/** Render the terminal's program icon on the left of a row, matching Herdr.app's sidebar. */
export function progIcon(t, customIcons) {
  const key = resolveKey(t);
  const entry = customIcons?.[key] ?? BUILTIN[key] ?? (t?.app ? BUILTIN.agent : BUILTIN.program);
  if (!entry.tint) {
    const img = document.createElement('img');
    img.className = 'prog-ico';
    img.alt = '';
    img.src = `data:image/svg+xml;utf8,${encodeURIComponent(entry.svg.replace(/<\?xml[^>]*\?>\s*/i, ''))}`;
    return img;
  }
  const span = document.createElement('span');
  span.className = 'prog-ico tint';
  span.innerHTML = normalizeTintedSvg(entry.svg);
  return span;
}

/** Render the right-side status indicator matching Herdr.app's sidebar (working spinner, done dot, idle ring). */
export function statusIcon(state) {
  if (state === 'working') {
    const span = document.createElement('span');
    span.className = 'st-spin';
    span.innerHTML = SPINNER_SVG;
    return span;
  }
  if (state === 'done') {
    const span = document.createElement('span');
    span.className = 'st-dot done';
    return span;
  }
  if (state === 'idle') {
    const span = document.createElement('span');
    span.className = 'st-ring';
    return span;
  }
  return null;
}
