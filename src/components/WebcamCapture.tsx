import { useRef, useState, useEffect, useCallback } from "react";
import Webcam from "react-webcam";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { captureScreen } from "@/utils/screenCapture";

interface Session {
  id: string;
  connectedAt: string;
  lastActivity: string;
  isStale: boolean;
  capabilities: {
    sampling: boolean;
    tools: boolean;
    resources: boolean;
  };
  clientInfo?: {
    name: string;
    version: string;
  };
}

export function WebcamCapture() {
  const [webcamInstance, setWebcamInstance] = useState<Webcam | null>(null);
  const clientIdRef = useRef<string | null>(null);
  const [_, setClientId] = useState<string | null>(null);

  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<string>("default");
  const [frozenFrame, setFrozenFrame] = useState<string | null>(null);

  // New state for sampling results
  const [samplingResult, setSamplingResult] = useState<string | null>(null);
  const [samplingError, setSamplingError] = useState<string | null>(null);
  const [isSampling, setIsSampling] = useState(false);

  // State for sampling prompt and auto-update
  const [samplingPrompt, setSamplingPrompt] =
    useState<string>("What can you see?");
  const [autoUpdate, setAutoUpdate] = useState<boolean>(false);
  const [updateInterval, setUpdateInterval] = useState<number>(30);
  const autoUpdateIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // State for session management
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    null
  );
  const sessionPollIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Get the currently selected session
  const selectedSession = sessions.find(s => s.id === selectedSessionId);

  const getImage = useCallback(() => {
    console.log("getImage called, frozenFrame state:", frozenFrame);
    if (frozenFrame) {
      console.log("Using frozen frame");
      return frozenFrame;
    }
    console.log("Getting live screenshot");
    const screenshot = webcamInstance?.getScreenshot();
    return screenshot || null;
  }, [frozenFrame, webcamInstance]);

  const toggleFreeze = () => {
    console.log("toggleFreeze called, current frozenFrame:", frozenFrame);
    if (frozenFrame) {
      console.log("Unfreezing frame");
      setFrozenFrame(null);
    } else if (webcamInstance) {
      console.log("Freezing new frame");
      const screenshot = webcamInstance.getScreenshot();
      if (screenshot) {
        console.log("New frame captured successfully");
        setFrozenFrame(screenshot);
      }
    }
  };

  const handleScreenCapture = async () => {
    console.log("Screen capture button clicked");
    try {
      const screenImage = await captureScreen();
      console.log("Got screen image, length:", screenImage.length);

      // Test if we can even get this far
      alert("Screen captured! Check console for details.");

      if (!clientIdRef.current) {
        console.error("No client ID available");
        return;
      }

      const response = await fetch("/api/capture-result", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: clientIdRef.current,
          image: screenImage,
          type: "screen",
        }),
      });

      console.log("Server response:", response.status);
    } catch (error) {
      console.error("Screen capture error:", error);
      alert("Screen capture failed: " + (error as Error).message);
    }
  };

  // New function to handle sampling
  const handleSample = async () => {
    console.log("Sample button clicked");
    setSamplingError(null);
    setSamplingResult(null);
    setIsSampling(true);

    try {
      const imageSrc = getImage();
      if (!imageSrc) {
        throw new Error("Failed to capture image for sampling");
      }

      console.log("Sending image for sampling...");

      // Add timeout to prevent hanging requests
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

      const response = await fetch("/api/process-sample", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image: imageSrc,
          prompt: samplingPrompt,
          sessionId: selectedSessionId,
        }),
        signal: controller.signal,
      }).catch((error) => {
        clearTimeout(timeoutId);
        if (error.name === "AbortError") {
          throw new Error("Request timed out after 30 seconds");
        }
        throw error;
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to process sample");
      }

      const data = await response.json();
      console.log("Sampling response:", data);

      if (data.success && data.result && data.result.content?.type === "text") {
        setSamplingResult(data.result.content.text);
      } else {
        throw new Error("Invalid sampling result format");
      }
    } catch (error) {
      console.error("Sampling error:", error);
      setSamplingError((error as Error).message || "An unknown error occurred");
    } finally {
      setIsSampling(false);
    }
  };

  useEffect(() => {
    const getDevices = async () => {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devices.filter(
          (device) => device.kind === "videoinput"
        );
        setDevices(videoDevices);
        setSelectedDevice("default");
      } catch (error) {
        console.error("Error getting devices:", error);
      }
    };

    getDevices();
    navigator.mediaDevices.addEventListener("devicechange", getDevices);
    return () => {
      navigator.mediaDevices.removeEventListener("devicechange", getDevices);
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
              const error = !webcamInstance
                ? "Webcam not initialized"
                : "Client ID not set";
              await fetch("/api/capture-error", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  clientId: clientIdRef.current,
                  error: { message: error },
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
                  error: { message: "Failed to capture image" },
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
                  type: "screen",
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
                  error: {
                    message:
                      (error as Error).message || "Screen capture failed",
                  },
                }),
              });
            }
            break;

          case "sample":
            // Handle sample event if needed (currently handled directly by handle Sample function)
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

  // Handle auto-update
  useEffect(() => {
    if (autoUpdate && updateInterval > 0) {
      // Initial sample when auto-update is enabled
      handleSample();

      // Set up interval
      autoUpdateIntervalRef.current = setInterval(() => {
        handleSample();
      }, updateInterval * 1000);

      return () => {
        if (autoUpdateIntervalRef.current) {
          clearInterval(autoUpdateIntervalRef.current);
          autoUpdateIntervalRef.current = null;
        }
      };
    } else {
      // Clear interval if auto-update is disabled
      if (autoUpdateIntervalRef.current) {
        clearInterval(autoUpdateIntervalRef.current);
        autoUpdateIntervalRef.current = null;
      }
    }
  }, [autoUpdate, updateInterval]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll for active sessions
  useEffect(() => {
    const fetchSessions = async () => {
      try {
        const response = await fetch("/api/sessions");
        if (response.ok) {
          const data = await response.json();
          setSessions(data.sessions);

          // Auto-select the most recent session if none selected
          if (!selectedSessionId && data.sessions.length > 0) {
            // Sort by connection time and select the most recent
            const sortedSessions = [...data.sessions].sort(
              (a, b) =>
                new Date(b.connectedAt).getTime() -
                new Date(a.connectedAt).getTime()
            );
            setSelectedSessionId(sortedSessions[0].id);
          }

          // Clean up selected session if it's no longer available
          if (
            selectedSessionId &&
            !data.sessions.find((s: Session) => s.id === selectedSessionId)
          ) {
            setSelectedSessionId(null);
          }
        }
      } catch (error) {
        console.error("Error fetching sessions:", error);
      }
    };

    // Initial fetch
    fetchSessions();

    // Poll every 2 seconds
    sessionPollIntervalRef.current = setInterval(fetchSessions, 2000);

    return () => {
      if (sessionPollIntervalRef.current) {
        clearInterval(sessionPollIntervalRef.current);
      }
    };
  }, [selectedSessionId]);

  return (
    <div className="container mx-auto p-4">
      <Card className="max-w-2xl mx-auto">
        <CardHeader>
          <CardTitle className="text-2xl font-bold text-center">
            mcp-webcam
          </CardTitle>
          <div className="w-full max-w-2xl mx-auto mt-4 space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Camera selector */}
              <div className="space-y-2">
                <label className="text-sm font-medium">Camera</label>
                <Select value={selectedDevice} onValueChange={setSelectedDevice}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select camera" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="default">Default camera</SelectItem>
                    {devices.map((device) => {
                      const deviceId =
                        device.deviceId || `device-${devices.indexOf(device)}`;
                      return (
                        <SelectItem key={deviceId} value={deviceId}>
                          {device.label || `Camera ${devices.indexOf(device) + 1}`}
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              </div>

              {/* Session selector - always visible */}
              <div className="space-y-2">
                <label className="text-sm font-medium">MCP Session</label>
                <Select
                  value={selectedSessionId || ""}
                  onValueChange={setSelectedSessionId}
                  disabled={sessions.length === 0}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder={sessions.length === 0 ? "No connections" : "Select MCP session"} />
                  </SelectTrigger>
                  <SelectContent>
                    {sessions.length === 0 ? (
                      <div className="p-2 text-center text-muted-foreground text-sm">
                        No MCP connections available
                      </div>
                    ) : (
                      sessions.map((session) => {
                        const connectedTime = new Date(session.connectedAt);
                        const timeString = connectedTime.toLocaleTimeString();
                        
                        // Determine color based on status
                        let colorClass = "bg-red-500"; // Default: stale
                        if (!session.isStale) {
                          if (session.capabilities.sampling) {
                            colorClass = "bg-green-500"; // Active with sampling
                          } else {
                            colorClass = "bg-amber-500"; // Active without sampling
                          }
                        }
                        
                        return (
                          <SelectItem key={session.id} value={session.id}>
                            <div className="flex items-center gap-2">
                              <div
                                className={`w-2 h-2 rounded-full ${colorClass}`}
                              />
                              <span>
                                {session.clientInfo
                                  ? `${session.clientInfo.name} v${session.clientInfo.version}`
                                  : `Session ${session.id.slice(0, 8)}`}
                              </span>
                              <span className="text-xs text-muted-foreground">
                                ({timeString})
                              </span>
                            </div>
                          </SelectItem>
                        );
                      })
                    )}
                  </SelectContent>
                </Select>
              </div>
            </div>
            {sessions.length > 0 && (
              <div className="text-xs text-muted-foreground text-center">
                <span className="inline-flex items-center gap-1">
                  <div className="w-2 h-2 rounded-full bg-green-500" />{" "}
                  Active with sampling
                </span>
                <span className="inline-flex items-center gap-1 ml-3">
                  <div className="w-2 h-2 rounded-full bg-amber-500" />{" "}
                  Active, no sampling
                </span>
                <span className="inline-flex items-center gap-1 ml-3">
                  <div className="w-2 h-2 rounded-full bg-red-500" />{" "}
                  Stale connection
                </span>
              </div>
            )}
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
                ...(selectedDevice !== "default"
                  ? { deviceId: selectedDevice }
                  : { facingMode: "user" }),
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
        <CardFooter className="flex flex-col gap-4 pb-6">
          <div className="flex flex-wrap justify-center gap-4">
            <Button
              onClick={toggleFreeze}
              variant={frozenFrame ? "destructive" : "outline"}
              size="lg"
            >
              {frozenFrame ? "Unfreeze" : "Freeze"}
            </Button>
            <Button onClick={handleScreenCapture} variant="secondary" size="lg">
              Capture Screen
            </Button>
          </div>

          <div className="w-full space-y-4">
            {selectedSession && !selectedSession.capabilities.sampling && (
              <Alert className="mb-4">
                <AlertDescription>
                  The selected MCP session does not support sampling. Please connect a client with sampling capabilities.
                </AlertDescription>
              </Alert>
            )}
            <div className="flex gap-2">
              <Input
                type="text"
                value={samplingPrompt}
                onChange={(e) => setSamplingPrompt(e.target.value)}
                placeholder="Enter your question..."
                className="flex-1"
              />
              <Button
                onClick={handleSample}
                variant="default"
                disabled={isSampling || autoUpdate || !selectedSession?.capabilities.sampling}
                title={!selectedSession?.capabilities.sampling ? "Selected session does not support sampling" : ""}
              >
                {isSampling ? "Sampling..." : "Sample"}
              </Button>
            </div>

            <div className="flex items-center gap-4">
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="auto-update"
                  checked={autoUpdate}
                  onCheckedChange={(checked) =>
                    setAutoUpdate(checked as boolean)
                  }
                  disabled={!selectedSession?.capabilities.sampling}
                />
                <label
                  htmlFor="auto-update"
                  className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                >
                  Auto-update
                </label>
              </div>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  value={updateInterval}
                  onChange={(e) =>
                    setUpdateInterval(parseInt(e.target.value) || 30)
                  }
                  className="w-20"
                  min="1"
                  disabled={!autoUpdate || !selectedSession?.capabilities.sampling}
                />
                <span className="text-sm text-muted-foreground">seconds</span>
              </div>
            </div>

            {/* Sampling results display - always visible */}
            <div className="mt-4 min-h-[80px]">
              {samplingResult && (
                <Alert>
                  <AlertTitle>Analysis Result</AlertTitle>
                  <AlertDescription>{samplingResult}</AlertDescription>
                </Alert>
              )}

              {samplingError && (
                <Alert variant="destructive">
                  <AlertTitle>Sampling Error</AlertTitle>
                  <AlertDescription>{samplingError}</AlertDescription>
                </Alert>
              )}

              {!samplingResult && !samplingError && !isSampling && (
                <div className="text-center text-muted-foreground text-sm p-4 border rounded-lg">
                  Sampling results will appear here
                </div>
              )}

              {isSampling && (
                <div className="text-center text-muted-foreground text-sm p-4 border rounded-lg">
                  Processing image...
                </div>
              )}
            </div>
          </div>
        </CardFooter>
      </Card>
    </div>
  );
}
