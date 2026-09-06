/**
 * The status bar is 32px of 11px text. Its menus keep to that scale rather
 * than the roomy default of the shared dropdown, and every status bar menu
 * draws from the same three strings so they cannot drift apart.
 */
export const DENSE_MENU = "min-w-40 rounded-lg p-1";
export const DENSE_MENU_ITEM = "gap-2 rounded-md px-2 py-1 text-xs";
export const DENSE_MENU_SEPARATOR = "-mx-1 my-1";
/** Icons inside a dense item; the item would otherwise force them to 16px. */
export const DENSE_MENU_ICON = "size-[13px] text-muted-foreground";
