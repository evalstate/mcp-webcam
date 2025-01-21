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
