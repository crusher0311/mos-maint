// lib/sidebar-nav.ts
// Pure feature-gating filter for the dashboard sidebar nav tree.
//
// Extracted from components/ui/Sidebar.tsx so the show/hide behavior of
// entitlement-gated nav items (auto_booking, oil_sticker, part_xref,
// estimate_assist, ...) can be unit-tested without rendering the client
// component. The Sidebar builds its NavItem[] (with icons) and passes it
// through `filterNavItemsByFeatures` with the shop's enabled feature ids.

// Minimal structural shape — extra props (name, href, icon, isModal, ...)
// on the caller's concrete type pass through untouched.
export interface GatedNavNode {
  featureId?: string;
  children?: GatedNavNode[];
}

/**
 * Returns the nav tree with every node whose `featureId` is not in
 * `enabledFeatures` removed. Applies recursively; a parent whose children
 * were ALL filtered out (and that had children to begin with) is dropped,
 * matching the Sidebar's long-standing behavior for grandchild groups.
 */
export function filterNavItemsByFeatures<T extends GatedNavNode>(
  items: T[],
  enabledFeatures: string[],
): T[] {
  return items
    .filter(item => !item.featureId || enabledFeatures.includes(item.featureId))
    .map(item => {
      if (!item.children) return item;
      return {
        ...item,
        children: filterNavItemsByFeatures(item.children, enabledFeatures),
      };
    })
    .filter(item => {
      // Drop groups whose children were all gated away.
      if (item.children && item.children.length === 0) return false;
      return true;
    });
}
