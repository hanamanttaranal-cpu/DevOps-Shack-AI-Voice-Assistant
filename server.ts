/**
 * Express + Gemini Live backend for DevOps Shack VoiceOps Assistant.
 */

import http from "http";
import path from "path";
import dotenv from "dotenv";
import express from "express";
import { WebSocket, WebSocketServer } from "ws";
import { FunctionResponse, GoogleGenAI, LiveServerMessage, Modality } from "@google/genai";
import { DEVOPS_SHACK_INSTRUCTION } from "./src/persona";
import { dispatchTool, TOOL_DECLARATIONS } from "./src/tools";

dotenv.config();

const PORT = 3000;
const MODEL = process.env.LIVE_MODEL || "gemini-3.8-live";
const VOICE = process.env.LIVE_VOICE || "Aoede";

const app = express();
app.use(express.json());

// CORS headers for safety
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "*");
  res.header("Access-Control-Allow-Headers", "*");
  next();
});

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    application: "DevOps Shack VoiceOps Assistant",
    model: MODEL,
    voice: VOICE,
  });
});

// Serve frontend static assets
const FRONTEND_DIR = path.join(process.cwd(), "frontend");
app.use(express.static(FRONTEND_DIR));
app.get("*", (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, "index.html"));
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY or GOOGLE_API_KEY environment variable is required.");
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
}

wss.on("connection", async (clientWs: WebSocket) => {
  console.log(`[WS] Browser connected. Opening Gemini Live session (model=${MODEL}, voice=${VOICE})`);

  let liveSession: any = null;

  try {
    const ai = getGeminiClient();

    liveSession = await ai.live.connect({
      model: MODEL,
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: DEVOPS_SHACK_INSTRUCTION,
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: VOICE },
          },
        },
        tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
      },
      callbacks: {
        onopen: () => {
          console.log("[Gemini Live] Session connected");
        },
        onmessage: async (message: LiveServerMessage) => {
          try {
            if (message.serverContent) {
              const inputTx = message.serverContent.inputTranscription;
              const outputTx = message.serverContent.outputTranscription;
              const modelTurn = message.serverContent.modelTurn;

              if (inputTx?.text) {
                clientWs.send(
                  JSON.stringify({
                    type: "transcript",
                    role: "user",
                    text: inputTx.text,
                  })
                );
              }

              if (outputTx?.text) {
                clientWs.send(
                  JSON.stringify({
                    type: "transcript",
                    role: "assistant",
                    text: outputTx.text,
                  })
                );
              }

              if (modelTurn?.parts) {
                for (const part of modelTurn.parts) {
                  if (part.inlineData?.data) {
                    const audioBuffer = Buffer.from(part.inlineData.data, "base64");
                    clientWs.send(audioBuffer);
                  }
                }
              }

              if (message.serverContent.interrupted) {
                clientWs.send(JSON.stringify({ type: "interrupted" }));
              }
            }

            if (message.toolCall?.functionCalls) {
              const responses: FunctionResponse[] = [];
              for (const call of message.toolCall.functionCalls) {
                if (!call.name) continue;
                const args = (call.args as Record<string, any>) || {};
                const [event, result] = await dispatchTool(call.name, args);

                clientWs.send(JSON.stringify({ type: "tool_result", ...event }));

                responses.push({
                  id: call.id,
                  name: call.name,
                  response: result,
                });
              }

              if (liveSession && responses.length > 0) {
                liveSession.sendToolResponse({ functionResponses: responses });
              }
            }
          } catch (err: any) {
            console.error("[Gemini Live] Message handling error:", err);
          }
        },
        onerror: (err: any) => {
          console.error("[Gemini Live] Error:", err);
          try {
            clientWs.send(
              JSON.stringify({
                type: "error",
                message: `Gemini Live error: ${err?.message || err}`,
              })
            );
          } catch {}
        },
        onclose: () => {
          console.log("[Gemini Live] Session closed");
        },
      },
    });

    clientWs.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      try {
        if (isBinary && liveSession) {
          const rawBuffer = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
          const base64Audio = rawBuffer.toString("base64");
          liveSession.sendRealtimeInput({
            audio: {
              data: base64Audio,
              mimeType: "audio/pcm;rate=16000",
            },
          });
        }
      } catch (err: any) {
        console.error("[WS] Failed to forward client input:", err);
      }
    });

    clientWs.on("close", () => {
      console.log("[WS] Browser disconnected");
      if (liveSession) {
        try {
          liveSession.close();
        } catch {}
      }
    });
  } catch (exc: any) {
    console.error("[WS] Session initialization failed:", exc);
    try {
      clientWs.send(
        JSON.stringify({
          type: "error",
          message: `${exc?.name || "Error"}: ${exc?.message || exc}`,
        })
      );
    } catch {}
  }
});

server.on("upgrade", (request, socket, head) => {
  const { pathname } = new URL(request.url || "", `http://${request.headers.host || "localhost"}`);
  if (pathname === "/ws") {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`DevOps Shack VoiceOps server listening on http://0.0.0.0:${PORT}`);
});
