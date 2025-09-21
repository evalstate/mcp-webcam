import "./App.css";
import { WebcamCapture } from "./components/WebcamCapture";

function App() {
  return (
    <div className="min-h-screen bg-background">
      <main className="py-2 sm:py-4">
        <div className="container mx-auto px-2 sm:px-4">
          <WebcamCapture />
        </div>
      </main>
    </div>
  );
}

export default App;
