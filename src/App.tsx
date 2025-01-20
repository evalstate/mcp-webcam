
import "./App.css";
import { WebcamCapture } from "./components/WebcamCapture";

function App() {
  return (
    <div className="min-h-screen bg-background">
      <main className="py-8">
        <h1 className="text-3xl font-bold text-center mb-8">MCP Webcam Capture</h1>
        <WebcamCapture />
      </main>
    </div>
  );
}

export default App;
