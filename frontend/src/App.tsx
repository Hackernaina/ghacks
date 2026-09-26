import { useEffect, useMemo, useState } from "react";
import Checkout from "./Checkout";
import Ops from "./Ops";

export default function App() {
  const hash = useHash();
  const page = hash === "#ops" ? "ops" : "checkout";
  return (
    <>
      <nav className="top">
        <strong>payment reconciliation</strong>
        <a className={page === "checkout" ? "active" : ""} href="#checkout">
          Checkout
        </a>
        <a className={page === "ops" ? "active" : ""} href="#ops">
          Ops dashboard
        </a>
      </nav>
      {page === "ops" ? <Ops /> : <Checkout />}
    </>
  );
}

function useHash() {
  const [h, setH] = useState(window.location.hash);
  useEffect(() => {
    const on = () => setH(window.location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return useMemo(() => h, [h]);
}
