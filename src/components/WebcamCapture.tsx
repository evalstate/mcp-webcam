import { useRef, useState, useEffect, useCallback } from "react";
import Webcam from "react-webcam";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { captureScreen } from "@/utils/screenCapture";

export function WebcamCapture() {
  const [webcamInstance, setWebcamInstance] = useState<Webcam | null>(null);
  const clientIdRef = useRef<string | null>(null);
  const [_, setClientId] = useState<string | null>(null);

  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<string>("default");
  const [frozenFrame, setFrozenFrame] = useState<string | null>(null);

  const getImage = useCallback(() => {
    console.log('getImage called, frozenFrame state:', frozenFrame);
    if (frozenFrame) {
      console.log('Using frozen frame');
      return frozenFrame;
    }
    console.log('Getting live screenshot');
    const screenshot = webcamInstance?.getScreenshot();
    return screenshot || null;
  }, [frozenFrame, webcamInstance]);

  const toggleFreeze = () => {
    console.log('toggleFreeze called, current frozenFrame:', frozenFrame);
    if (frozenFrame) {
      console.log('Unfreezing frame');
      setFrozenFrame(null);
    } else if (webcamInstance) {
      console.log('Freezing new frame');
      const screenshot = webcamInstance.getScreenshot();
      if (screenshot) {
        console.log('New frame captured successfully');
        setFrozenFrame(screenshot);
      }
    }
  };

  const handleScreenCapture = async () => {
    console.log('Screen capture button clicked');
    try {
      const screenImage = await captureScreen();
      console.log('Got screen image, length:', screenImage.length);
      
      // Test if we can even get this far
      alert('Screen captured! Check console for details.');
      
      if (!clientIdRef.current) {
        console.error('No client ID available');
        return;
      }

      const response = await fetch("/api/capture-result", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: clientIdRef.current,
          image: screenImage,
          type: "screen"
        }),
      });
      
      console.log('Server response:', response.status);
      
    } catch (error) {
      console.error("Screen capture error:", error);
      alert('Screen capture failed: ' + (error as Error).message);
    }
  };

  useEffect(() => {
    const getDevices = async () => {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devices.filter(device => device.kind === 'videoinput');
        setDevices(videoDevices);
        setSelectedDevice("default");
      } catch (error) {
        console.error("Error getting devices:", error);
      }
    };

    getDevices();
    navigator.mediaDevices.addEventListener('devicechange', getDevices);
    return () => {
      navigator.mediaDevices.removeEventListener('devicechange', getDevices);
    };
  }, []);

  useEffect(() => {
    console.error("Setting up EventSource...");

    const eventSource = new EventSource("/api/events");

    eventSource.onopen = () => {
      console.error("SSE connection opened successfully");
    };

    eventSource.onerror = (error) => {
      console.error("SSE connection error:", error);
    };

    eventSource.onmessage = async (event) => {
      console.log("Received message:", event.data);

      try {
        const data = JSON.parse(event.data);

        switch (data.type) {
          case "connected":
            console.log("Connected with client ID:", data.clientId);
            clientIdRef.current = data.clientId; // Store in ref
            setClientId(data.clientId); // Keep state in sync if needed for UI
            break;

          case "capture":
            console.log(`Capture triggered - webcam status:`, !!webcamInstance);
            if (!webcamInstance || !clientIdRef.current) {
              const error = !webcamInstance ? "Webcam not initialized" : "Client ID not set";
              await fetch("/api/capture-error", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  clientId: clientIdRef.current,
                  error: { message: error }
                }),
              });
              return;
            }

            console.log("Taking webcam image...");
            const imageSrc = getImage();
            if (!imageSrc) {
              await fetch("/api/capture-error", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  clientId: clientIdRef.current,
                  error: { message: "Failed to capture image" }
                }),
              });
              return;
            }
            
            await fetch("/api/capture-result", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                clientId: clientIdRef.current,
                image: imageSrc,
              }),
            });
            console.log("Image sent to server");
            break;

          case "screenshot":
            console.log("Screen capture triggered");
            if (!clientIdRef.current) {
              console.error("Cannot capture - client ID not set");
              return;
            }
            try {
              const screenImage = await captureScreen();
              await fetch("/api/capture-result", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  clientId: clientIdRef.current,
                  image: screenImage,
                  type: "screen"
                }),
              });
              console.log("Screen capture sent to server");
            } catch (error) {
              console.error("Screen capture failed:", error);
              await fetch("/api/capture-error", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  clientId: clientIdRef.current,
                  error: { message: (error as Error).message || "Screen capture failed" }
                }),
              });
            }
            break;

          default:
            console.warn("Unknown message type:", data.type);
        }
      } catch (error) {
        console.error(
          "Error processing message:",
          error,
          "Raw message:",
          event.data
        );
      }
    };

    return () => {
      console.error("Cleaning up EventSource connection");
      eventSource.close();
    };
  }, [webcamInstance, getImage]); // Add getImage to dependencies

  return (
    <div className="container mx-auto p-4">
      <Card className="max-w-2xl mx-auto">
        <CardHeader>
          <CardTitle className="text-2xl font-bold text-center">Camera Capture</CardTitle>
          <div className="w-full max-w-xs mx-auto mt-4">
            <Select
              value={selectedDevice}
              onValueChange={setSelectedDevice}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select camera" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">Default camera</SelectItem>
                {devices.map((device) => (
                  <SelectItem key={device.deviceId} value={device.deviceId}>
                    {device.label || `Camera ${devices.indexOf(device) + 1}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent className="p-6">
          <div className="rounded-lg overflow-hidden border border-border relative">
            <Webcam
              ref={(webcam) => setWebcamInstance(webcam)}
              screenshotFormat="image/jpeg"
              className="w-full"
              videoConstraints={{
                width: 1280,
                height: 720,
                ...(selectedDevice !== "default" ? { deviceId: selectedDevice } : { facingMode: "user" })
              }}
            />
            {frozenFrame && (
              <img
                src={frozenFrame}
                alt="Frozen frame"
                className="absolute inset-0 w-full h-full object-cover"
              />
            )}
            {frozenFrame && (
              <div className="absolute top-4 right-4">
                <div className="bg-red-500 text-white px-3 py-1 rounded-full text-sm">
                  Frozen
                </div>
              </div>
            )}
          </div>
        </CardContent>
        <CardFooter className="flex justify-center gap-4 pb-6">
          <Button
            onClick={toggleFreeze}
            variant={frozenFrame ? "destructive" : "outline"}
            size="lg"
          >
            {frozenFrame ? "Unfreeze" : "Freeze"}
          </Button>
          <Button
            onClick={handleScreenCapture}
            variant="secondary"
            size="lg"
          >
            Capture Screen
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
