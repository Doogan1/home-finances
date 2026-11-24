/** Line icons for the navigation, on a 24 by 24 grid in the text colour. Decorative: the link text names the page. */
const PATHS = {
  home: "M4 11.5 12 4l8 7.5M6 10v10h4.5v-5.5h3V20H18V10",
  register: "M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01",
  calendar: "M5 6h14v14H5zM5 10.5h14M9 3.5V8M15 3.5V8",
  bills: "M6 3.5v17l2-1.5 2 1.5 2-1.5 2 1.5 2-1.5 2 1.5v-17zM9.5 8.5h5M9.5 12.5h5",
  accounts: "M4 7.5h15a1 1 0 0 1 1 1V18a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1zM4 7.5 16 4v3.5M16 13.5h.01",
  transactions: "M4 8.5h15M15.5 5 19 8.5 15.5 12M20 15.5H5M8.5 12 5 15.5 8.5 19",
  connections: "M4 10 12 4l8 6zM6 10v8M10 10v8M14 10v8M18 10v8M4 20h16",
  balances: "m4 20 1-4L16 5l3 3L8 19zM14 7l3 3",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  signOut: "M10 4H5v16h5M14 8l4 4-4 4M18 12H9",
} as const;

export type NavIconName = keyof typeof PATHS;

export function NavIcon({ name }: { name: NavIconName }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={name === "more" ? 2.5 : 1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
