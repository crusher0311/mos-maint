// lib/sidebar-nav.ts
// Pure feature-gating filter for the dashboard sidebar nav tree.
//
// Extracted from components/ui/Sidebar.tsx so the show/hide behavior of
// entitlement-gated nav items (auto_booking, oil_sticker, part_xref,
// estimate_assist, ...) can be unit-tested without rendering the client
// component. The Sidebar builds its NavItem[] (with icons) and passes it
// through `filterNavItemsByFeatures` with the shop's enabled feature ids.

// Minimal structural shape — extra props (name, href, icon, ...) on the
// caller's concrete type pass through untouched.
export interface GatedNavNode {
  featureId?: string;
  children?: GatedNavNode[];
  /**
   * Opt-in "locked" treatment for gated items. When the shop lacks the
   * feature, the item stays in the nav marked `locked: true` (lock icon,
   * muted style, still clickable) instead of disappearing — the target
   * page's own gate then shows the upgrade CTA. Only safe on non-modal
   * items whose destination page renders an upgrade CTA when un-entitled
   * (e.g. /dashboard/estimate-audit).
   */
  showWhenLocked?: boolean;
  /** True when this item's page navigates fine but its own gate opens a modal. */
  isModal?: boolean;
  /** Output flag set by the filter — never set this in nav declarations. */
  locked?: boolean;
}

/**
 * Returns the nav tree with every node whose `featureId` is not in
 * `enabledFeatures` removed — unless the node opts into the locked
 * treatment via `showWhenLocked`, in which case it is kept with
 * `locked: true` so the sidebar can render it muted with a lock icon.
 * Locked treatment is ONE consistent rule: un-entitled + showWhenLocked +
 * not a modal + no children => keep locked; everything else gated hides
 * as before. Applies recursively; a parent whose children were ALL
 * filtered out (and that had children to begin with) is dropped,
 * matching the Sidebar's long-standing behavior for grandchild groups.
 */
export function filterNavItemsByFeatures<T extends GatedNavNode>(
  items: T[],
  enabledFeatures: string[],
): T[] {
  return items
    .map(item => {
      const entitled = !item.featureId || enabledFeatures.includes(item.featureId);
      if (entitled) return item;
      // Locked treatment: only for non-modal leaf items that opted in.
      // Modals have no page-side gate to land on, and groups would leak
      // their (possibly ungated) children.
      if (item.showWhenLocked && !item.isModal && !item.children) {
        return { ...item, locked: true };
      }
      return null;
    })
    .filter((item): item is T => item !== null)
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
