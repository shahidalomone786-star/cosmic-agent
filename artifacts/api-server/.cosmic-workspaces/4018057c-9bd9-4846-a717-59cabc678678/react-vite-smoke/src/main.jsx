import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

function App() {
  const [count, setCount] = useState(0);
  return <main className="card"><p className="eyebrow">Vite + React</p><h1>React Workspace</h1><p>Create a React Vite counter app with a button that increments a count</p><button onClick={() => setCount((value) => value + 1)}>Clicked {count} times</button></main>;
}

createRoot(document.getElementById("root")).render(<App />);