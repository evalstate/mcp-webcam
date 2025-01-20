import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;


// Important: Serve the dist directory directly
app.use(express.static(__dirname));

// Simple health check
app.get('/api/health', (_, res) => {
  res.json({ status: 'ok' });
});

// For any other route, send the index.html file
app.get('*', (_, res) => {
  // Important: Send the built index.html
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});