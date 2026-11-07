// Shared ownership counter for the `inert` attribute on the app-shell regions.
// More than one feature can need the same element inert at the same time (the
// confirm dialog and the mobile drawer both hold `.app-content`), so a plain
// setAttribute/removeAttribute pair from either of them un-inerts the other's
// hold. Elements are therefore reference counted: an element stays inert until
// its last holder releases it, and an element that was already inert when it
// was acquired (markup or a React attribute owns it) is never un-inerted here.

const holderCounts = new WeakMap<Element, number>();

export function acquireInert(el: Element): void {
  const held = holderCounts.get(el) ?? 0;
  if (held > 0) {
    holderCounts.set(el, held + 1);
    return;
  }
  if (el.hasAttribute("inert")) return; // inert owned elsewhere: markup or React
  holderCounts.set(el, 1);
  el.setAttribute("inert", "");
}

export function releaseInert(el: Element): void {
  const held = holderCounts.get(el) ?? 0;
  if (held === 0) return; // not ours: never acquired (e.g. inert from markup)
  if (held > 1) {
    holderCounts.set(el, held - 1);
    return;
  }
  holderCounts.delete(el);
  el.removeAttribute("inert");
}
