import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "@fontsource-variable/ibm-plex-sans";
import "./styles.css";

createRoot(document.getElementById("root")).render(<React.StrictMode><App /></React.StrictMode>);
