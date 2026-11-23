# Serenity

Serenity is a small web chat UI for OpenAI-compatible model servers. It uses Node.js with plain HTML, CSS, and JavaScript. Docker is optional. Web search uses Python and DDGS, whether you run Serenity directly or in Docker.

## Run without Docker

Install Node.js 24 or newer and start an OpenAI-compatible model server, such as Ollama, llama.cpp, or LM Studio. Then, from the project folder, run:

```sh
npm ci
npm start
```

Open <http://127.0.0.1:8080>, configure the inference URL in **Settings**, and refresh the model list. The default URL is `http://127.0.0.1:11434/v1` (Ollama on the same machine).

To enable web search, install Python 3.10 or newer and DDGS:

```sh
python -m pip install -r requirements.txt
```

Serenity uses `python` on Windows and `python3` elsewhere. Set `SERENITY_PYTHON` to the Python executable if needed, for example when using a virtual environment. Python and DDGS are not required for chat without web search.

To upload PDFs without Docker, install Poppler and make `pdfinfo` and `pdftoppm` available on PATH.
To upload audio without Docker, install FFmpeg and LAME and make `ffmpeg`, `ffprobe`, and `lame` available on PATH.

You can set `HOST`, `PORT`, `DATA_DIR`, `INFERENCE_URL`, and `INFERENCE_API_KEY` as environment variables before starting the server.

## Run with Docker

Alternatively, install Docker with Compose and start your model server. Docker builds an image containing Node.js, Python, and DDGS:

```sh
docker compose up --build -d
```

Open <http://127.0.0.1:8080>, configure the inference URL in **Settings**, and refresh the model list. The default URL is `http://host.docker.internal:11434/v1` (Ollama on the Docker host). The model server must be reachable from the container.

Optionally, create a `.env` file next to `compose.yaml` to set initial values:

```dotenv
WEB_PORT=8080
INFERENCE_URL=http://host.docker.internal:11434/v1
# INFERENCE_API_KEY=your-api-key
# BIND_ADDRESS=127.0.0.1
```

Saved settings take precedence over initial inference settings. Stop the app with `docker compose down`; its named volume retains chats and settings.

## Tests

Run the tests with:

```sh
node --test
```

## Data and plugins

Chats and settings are stored in the Docker volume, or in `./data` when running from source. Settings can include API keys and MCP tokens; protect the data and its backups. Serenity has no authentication, so keep it on localhost or behind an authenticated reverse proxy.

Attachments use a temporary workspace for each conversation. The workspace holds up to 250 MiB, including compressed WebP images, PDF pages, MP3 audio, and media tool copies. Each audio upload becomes a directory of numbered MP3 chunks up to 28 seconds long. Deleting a conversation removes its workspace. Temp cleanup or container replacement can remove attachments from an otherwise preserved transcript.

Enable **Image tools** or **Audio tools** in the composer’s tool menu, or set their defaults in **Settings**. Image tools crop, zoom, and rotate. Audio tools trim, stretch, and clean up a recording chunk. Each edit returns the workspace path of a new copy. The `read_file` tool is always available for workspace text, images, and audio, including edited copies. Reading images or audio requires a model and endpoint that support that input alongside tool calls.

Place trusted plugin folders in `plugins/` and restart the app. See the [plugin guide](docs/plugins.md) and [example plugin](examples/word-count/). Web tools and MCP connections are configured in the app and require a model that supports tool calls.
