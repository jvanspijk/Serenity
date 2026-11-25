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
To use audio without Docker, install FFmpeg with the `libmp3lame` encoder and make `ffmpeg` and `ffprobe` available on PATH.

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

Chats, settings, and conversation workspaces are stored in the Docker volume, or in `./data` when running from source. Settings can include API keys and MCP tokens; protect the data and its backups. Serenity has no authentication, so keep it on localhost or behind an authenticated reverse proxy.

Attachments use a persistent workspace with a 250 MiB limit per conversation. Serenity stores the original upload bytes and renders previews, PDF pages, and audio chunks on demand. Deleting a conversation removes its workspace. `DATA_DIR` controls the storage location when running from source; `SERENITY_WORKSPACE_DIR` can set a separate workspace location.

Enable **Image tools** or **Audio tools** in the composer’s tool menu, or set their defaults in **Settings**. Crop and rotate accept a PDF attachment path and an optional page number in `chunk`. Image and audio edits return the rendered media to the model and a stable view path such as `/media/view-1.webp`. Serenity stores the recipe for each view and renders it from the original bytes. Use any view path to continue editing from that state, or the original path to start over. Clips sent to the model stay within 28 seconds. Reading media requires a model and endpoint that support it alongside tool calls.

Attachment links show the chunk count. Use the optional, 1-based `chunk` argument to `read_file` to select a PDF page or audio segment. If the file was stored as a single file, `read_file` returns it with a warning that it ignored the chunk selection.

Tool history retains the calls and text results, including paths. Serenity loads media from earlier turns when the model opens those paths with `read_file`.

Ask Serenity to show a workspace image or PDF page or play an audio clip in the chat. The `show_view` tool displays originals and edited views inline. Presented views remain available while their workspace files are available.

Failed tool calls are logged by the server. Use `docker compose logs serenity` to inspect their arguments. The logs can contain conversation data.

Place trusted plugin folders in `plugins/` and restart the app. See the [plugin guide](docs/plugins.md) and [example plugin](examples/word-count/). Web tools and MCP connections are configured in the app and require a model that supports tool calls.
