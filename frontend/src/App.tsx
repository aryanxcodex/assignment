import { BrowserRouter, Routes, Route, Link } from "react-router-dom";
import StreamPage from "./pages/StreamPage";
import WatchPage from "./pages/WatchPage";

function HomePage() {
  return (
    <div style={{ padding: "20px", textAlign: "center" }}>
      <h1>WebRTC to HLS Streaming</h1>
      <nav
        style={{
          display: "flex",
          justifyContent: "center",
          gap: "20px",
          marginTop: "20px",
        }}
      >
        <Link to="/stream" style={{ fontSize: "1.2em" }}>
          Go to Stream Page
        </Link>
        <Link to="/watch" style={{ fontSize: "1.2em" }}>
          Go to Watch Page
        </Link>
      </nav>
    </div>
  );
}

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/stream" element={<StreamPage />} />
        <Route path="/watch" element={<WatchPage />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
