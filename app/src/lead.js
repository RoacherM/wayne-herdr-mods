/**
 * Whether the phone still leads (its grid is the terminal's size) after a `size` event
 * (DESIGN.md「多个窗口怎么同步」). `fitSent` is the last grid the phone sent, as JSON: a size
 * other than it means a Mac window took the terminal back. Before the phone sent a grid, or while
 * it is away (`"null"`), a size says nothing about the phone, so `leads` stays as it was.
 */
export function leadsAfterSize(leads, fitSent, { cols, rows }) {
  if (!fitSent || fitSent === 'null') return leads;
  return fitSent === JSON.stringify({ cols, rows });
}
