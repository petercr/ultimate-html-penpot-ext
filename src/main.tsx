import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@penpot/plugin-styles/styles.css";
import "./styles.css";
import App from "./App";
import { themeFromLocation } from "./theme";

document.documentElement.dataset.theme = themeFromLocation(window.location.search, window.location.hash);

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
