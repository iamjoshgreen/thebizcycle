import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

// lightweight-charts can fire internal render/resize callbacks AFTER
// chart.remove() has been called (e.g. when navigating between pages with
// the measure tool active). Those throw "Object is disposed" from an
// async ResizeObserver callback, outside any of our try/catch blocks,
// which then trips Vite's runtime error overlay and looks like an app
// crash. The error is benign — the chart is already gone — so we
// swallow this specific message globally.
function isDisposedError(message: unknown): boolean {
  return typeof message === "string" && message.includes("Object is disposed");
}

window.addEventListener(
  "error",
  (e) => {
    if (isDisposedError(e.message) || isDisposedError(e.error?.message)) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  },
  true,
);

window.addEventListener(
  "unhandledrejection",
  (e) => {
    const reason = e.reason;
    const msg = typeof reason === "string" ? reason : reason?.message;
    if (isDisposedError(msg)) {
      e.preventDefault();
    }
  },
  true,
);

createRoot(document.getElementById("root")!).render(<App />);
