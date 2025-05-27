import "./App.css";
import { WebcamCapture } from "./components/WebcamCapture";

function App() {
  return (
    <div className="min-h-screen bg-background">
      <main className="pt-4 pb-8">
        <WebcamCapture />
      </main>
    </div>
  );
}

export default App;
