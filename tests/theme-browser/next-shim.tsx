import React from "react";
export default function Link({ children, href, src, ...props }: any) {
  return src ? <img src={src} {...props} /> : <a href={href} {...props}>{children}</a>;
}
export const usePathname = () => window.location.pathname;
export const useSearchParams = () => new URLSearchParams(window.location.search);
export const useRouter = () => ({ replace: (url: string) => { window.location.href = url; }, refresh: () => {} });
