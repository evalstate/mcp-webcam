export async function captureScreen(): Promise<string> {
    let stream: MediaStream | undefined;
    try {
        stream = await navigator.mediaDevices.getDisplayMedia({
            video: true,
            audio: false,
        });

        const canvas = document.createElement("canvas");
        const video = document.createElement("video");

        await new Promise((resolve) => {
            video.onloadedmetadata = () => {
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
                video.play();
                resolve(null);
            };
            if (stream) {
                video.srcObject = stream;
            } else {
                throw Error("No stream available");
            }
        });

        const context = canvas.getContext("2d");
        context?.drawImage(video, 0, 0, canvas.width, canvas.height);

        // Check if resizing is needed
        const MAX_DIMENSION = 1568;
        if (canvas.width > MAX_DIMENSION || canvas.height > MAX_DIMENSION) {
            const scaleFactor = MAX_DIMENSION / Math.max(canvas.width, canvas.height);
            const newWidth = Math.round(canvas.width * scaleFactor);
            const newHeight = Math.round(canvas.height * scaleFactor);

            const resizeCanvas = document.createElement("canvas");
            resizeCanvas.width = newWidth;
            resizeCanvas.height = newHeight;
            const resizeContext = resizeCanvas.getContext("2d");
            resizeContext?.drawImage(canvas, 0, 0, newWidth, newHeight);
            return resizeCanvas.toDataURL("image/png");
        }

        return canvas.toDataURL("image/png");
    } catch (error) {
        console.error("Error capturing screenshot:", error);
        throw error;
    } finally {
        if (stream) {
            stream.getTracks().forEach((track) => track.stop());
        }
    }
}
