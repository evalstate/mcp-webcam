// src/components/WebcamCapture.tsx
import { useCallback, useRef, useState } from 'react'
import Webcam from 'react-webcam'
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardFooter } from "@/components/ui/card"

export function WebcamCapture() {
  const webcamRef = useRef<Webcam>(null)
  const [capturedImage, setCapturedImage] = useState<string | null>(null)

  const capture = useCallback(() => {
    if (webcamRef.current) {
      const imageSrc = webcamRef.current.getScreenshot()
      setCapturedImage(imageSrc)
    }
  }, [webcamRef])

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
                facingMode: "user"
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
              <Button onClick={() => {
                // Download logic
                const link = document.createElement('a')
                link.href = capturedImage
                link.download = 'captured-image.jpg'
                link.click()
              }}>
                Save
              </Button>
            </>
          )}
        </CardFooter>
      </Card>
    </div>
  )
}