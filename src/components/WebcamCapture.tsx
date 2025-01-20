import { useCallback, useRef, useState, useEffect } from "react";
import Webcam from "react-webcam";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";

export function WebcamCapture() {
  const webcamRef = useRef<Webcam>(null);
  const clientIdRef = useRef<string | null>(null);
  const [capturedImage, setCapturedImage] = useState<string | null>(null);
  // We can keep the state for UI purposes if needed
  const [_, setClientId] = useState<string | null>(null);

  const capture = useCallback(() => {
    if (webcamRef.current) {
      const imageSrc = webcamRef.current.getScreenshot();
      setCapturedImage(imageSrc);
    }
  }, [webcamRef]); // Removed clientId from dependencies since it's not used

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
            console.log(`capture ${clientIdRef.current} -- ${webcamRef.current}`);
            if (!webcamRef.current || !clientIdRef.current) {
              console.error("Cannot capture - webcam or clientId not ready");
              return;
            }

            console.log("Capture command received");
            const imageSrc = webcamRef.current.getScreenshot();
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
  }, []); // Empty dependency array is fine now as we're using refs

  return (
    <div className="container mx-auto p-4">
      <Card className="max-w-2xl mx-auto">
        <CardContent className="p-4">
          {!capturedImage ? (
            <Webcam
              ref={webcamRef}
              screenshotFormat="image/jpeg"
              className="w-full rounded-lg"
              videoConstraints={{
                width: 1280,
                height: 720,
                facingMode: "user",
              }}
            />
          ) : (
            <img
              src={capturedImage}
              alt="Captured"
              className="w-full rounded-lg"
            />
          )}
        </CardContent>
        <CardFooter className="flex justify-center gap-4">
          {!capturedImage ? (
            <Button onClick={capture}>Capture</Button>
          ) : (
            <>
              <Button
                onClick={() => setCapturedImage(null)}
                variant="secondary"
              >
                Retake
              </Button>
              <Button
                onClick={() => {
                  // Download logic
                  const link = document.createElement("a");
                  link.href = capturedImage;
                  link.download = "captured-image.jpg";
                  link.click();
                }}
              >
                Save
              </Button>
            </>
          )}
        </CardFooter>
      </Card>
    </div>
  );
}
