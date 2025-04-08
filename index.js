import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import twilio from 'twilio';
dotenv.config();

const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  PHONE_NUMBER_FROM,
  DOMAIN: rawDomain,
  OPENAI_API_KEY,
} = process.env;

const SYSTEM_MESSAGE = `
You are a helpful, casual, and friendly AI assistant designed to make people feel heard, supported, and understood—like a smart best friend or that one really cool coworker who knows everything. Your main goals are:
  1. Answer any question with clarity and confidence—whether it’s technical, life advice, or random curiosity.
  2. Solve problems fully—don’t leave the user hanging. Go the extra mile.
  3. Keep the tone casual, relaxed, and Gen Z–aligned: slang (when appropriate), hype words, and memes if it fits the vibe.
  4. Know when to switch tones—be encouraging and uplifting when someone’s down, and hype them up when they’re doing great.
  5. NEVER talk down to the user. Make everything easy to understand, but never boring.
  6. End responses with good vibes, energy, or light humor when it feels right.
Tone: Friendly, clear, and reassuring, creating a calm atmosphere and making the listener feel confident and comfortable.
Your job: Be the go-to, all-knowing but chill digital sidekick. People should feel smarter, happier, and more confident after talking to you.
`;
const VOICE = 'sage';
const DOMAIN = rawDomain.replace(/(^\w+:|^)\/\//, '').replace(/\/+$/, '');
const PORT = process.env.PORT || 6060;
const outboundTwiML = `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="wss://${DOMAIN}/media-stream" /></Connect></Response>`;
const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// LOGGING
const LOG_EVENT_TYPES = [
  'error',
  'response.content.done',
  'rate_limits.updated',
  'response.done',
  'input_audio_buffer.committed',
  'input_audio_buffer.speech_stopped',
  'input_audio_buffer.speech_started',
  'session.created'
];
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !PHONE_NUMBER_FROM || !rawDomain || !OPENAI_API_KEY) {
  console.error('One or more environment variables are missing. Please ensure TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, PHONE_NUMBER_FROM, DOMAIN, and OPENAI_API_KEY are set.');
  process.exit(1);
}

// OUTBOUND CALL
async function makeCall(to) {
  try {

    const call = await client.calls.create({
      from: PHONE_NUMBER_FROM,
      to,
      twiml: outboundTwiML,
    });
    console.log(`Call started with SID: ${call.sid}`);
  } catch (error) {
    console.error('Error making call:', error);
  }
}

// WEBSOCKET ROUTE FOR MEDIA-STREAM
fastify.register(async (fastify) => {
  fastify.get('/media-stream', { websocket: true }, (connection, req) => {
    console.log('Client connected');

    // Connection-specific state
    let streamSid = null;
    let latestMediaTimestamp = 0;
    let lastAssistantItem = null;
    let markQueue = [];
    let responseStartTimestampTwilio = null;
    const SHOW_TIMING_MATH = false; // SHOW AI RESPONSE ELAPSED TIMING CALCULATIONS

    const openAiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1"
      }
    });


    const sendInitialSessionUpdate = () => {
      const sessionUpdate = {
        type: 'session.update',
        session: {
          turn_detection: { type: 'server_vad' },
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw',
          voice: VOICE,
          instructions: SYSTEM_MESSAGE,
          modalities: ["text", "audio"],
          temperature: 0.8,
        }
      };

      console.log('Sending session update:', JSON.stringify(sessionUpdate));
      openAiWs.send(JSON.stringify(sessionUpdate));

      const initialConversationItem = {
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: 'Greet the user with "Hello there! I\'m an Eklavya`s AI voice assistant. How can I help?'
            }
          ]
        }
      };

      openAiWs.send(JSON.stringify(initialConversationItem));
      openAiWs.send(JSON.stringify({ type: 'response.create' }));
    };

    // HANDLE INTERRUPTION WHEN THE CALLER'S SPEECH STARTS
    const handleSpeechStartedEvent = () => {
      if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
        const elapsedTime = latestMediaTimestamp - responseStartTimestampTwilio;
        if (SHOW_TIMING_MATH) console.log(`Calculating elapsed time for truncation: ${latestMediaTimestamp} - ${responseStartTimestampTwilio} = ${elapsedTime}ms`);

        if (lastAssistantItem) {
          const truncateEvent = {
            type: 'conversation.item.truncate',
            item_id: lastAssistantItem,
            content_index: 0,
            audio_end_ms: elapsedTime
          };
          if (SHOW_TIMING_MATH) console.log('Sending truncation event:', JSON.stringify(truncateEvent));
          openAiWs.send(JSON.stringify(truncateEvent));
        }

        connection.send(JSON.stringify({
          event: 'clear',
          streamSid: streamSid
        }));

        // Reset
        markQueue = [];
        lastAssistantItem = null;
        responseStartTimestampTwilio = null;
      }
    };
    // SEND MARK MESSAGES TO MEDIA STREAMS SO WE KNOW IF AND WHEN AI RESPONSE PLAYBACK IS FINISHED
    const sendMark = (connection, streamSid) => {
      if (streamSid) {
        const markEvent = {
          event: 'mark',
          streamSid: streamSid,
          mark: { name: 'responsePart' }
        };
        connection.send(JSON.stringify(markEvent));
        markQueue.push('responsePart');
      }
    };

    // OPEN EVENT FOR OPENAI WEBSOCKET
    openAiWs.on('open', () => {
      console.log('Connected to the OpenAI Realtime API');
      setTimeout(sendInitialSessionUpdate, 100); // ENSURE CONNECTION STABILITY, SEND AFTER .1 SECOND
    });

    // LISTEN FOR MESSAGES FROM THE OPENAI WEBSOCKET AND SEND TO TWILIO
    openAiWs.on('message', (data) => {
      try {
        const response = JSON.parse(data);

        if (LOG_EVENT_TYPES.includes(response.type)) {
          console.log(`Received event: ${response.type}`, response);
        }

        if (response.type === 'session.updated') {
          console.log('Session updated successfully:', response);
        }

        if (response.type === 'response.audio.delta' && response.delta) {
          const audioDelta = {
            event: 'media',
            streamSid: streamSid,
            media: { payload: Buffer.from(response.delta, 'base64').toString('base64') }
          };
          connection.send(JSON.stringify(audioDelta));
          if (!responseStartTimestampTwilio) {
            responseStartTimestampTwilio = latestMediaTimestamp;
            if (SHOW_TIMING_MATH) console.log(`Setting start timestamp for new response: ${responseStartTimestampTwilio}ms`);
          }

          if (response.item_id) {
            lastAssistantItem = response.item_id;
          }
          sendMark(connection, streamSid);
        }
        if (response.type === 'input_audio_buffer.speech_started') {
          handleSpeechStartedEvent();
        }
      } catch (error) {
        console.error('Error processing OpenAI message:', error, 'Raw message:', data);
      }
    });

    // HANDLE INCOMING MESSAGES FROM TWILIO
    connection.on('message', (message) => {
      try {
        const data = JSON.parse(message);

        switch (data.event) {
          case 'media':
            if (openAiWs.readyState === WebSocket.OPEN) {
              const audioAppend = {
                type: 'input_audio_buffer.append',
                audio: data.media.payload
              };

              openAiWs.send(JSON.stringify(audioAppend));
            }
            break;
          case 'start':
            streamSid = data.start.streamSid;
            console.log('Incoming stream has started', streamSid);
            break;
          default:
            console.log('Received non-media event:', data.event);
            break;
        }
      } catch (error) {
        console.error('Error parsing message:', error, 'Message:', message);
      }
    });

    // HANDLE CONNECTION CLOSE
    connection.on('close', () => {
      if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
      console.log('Client disconnected.');
    });

    // HANDLE WEBSOCKET CLOSE && ERRORS
    openAiWs.on('close', () => {
      console.log('Disconnected from the OpenAI Realtime API');
    });
    openAiWs.on('error', (error) => {
      console.error('Error in the OpenAI WebSocket:', error);
    });

  })
})
// ROOT ROUTE
fastify.get('/', async (request, res) => {
  res.send({ message: 'Twilio Media Stream Server is running 📞🚀' });
});

// INITIALIZE SERVER
fastify.listen({ port: PORT }, (err) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`Server is listening on port ${PORT}`);

  // PARSE COMMAND-LINE ARGUMENTS TO GET THE PHONE NUMBER
  const args = process.argv.slice(2);
  const phoneNumberArg = args.find(arg => arg.startsWith('--call='));
  if (!phoneNumberArg) {
    console.error('Provide a phone number to call, e.g., --call=+18885551212');
    process.exit(1);
  }
  const phoneNumberToCall = phoneNumberArg.split('=')[1].trim();
  console.log('Calling ', phoneNumberToCall);
  makeCall(phoneNumberToCall);
});