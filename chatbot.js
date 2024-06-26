const express = require("express");
const router = express.Router();
const { openai, prisma } = require("./clients");
const { verify, sign } = require("jsonwebtoken");
const Minio = require("minio");
const es = require("event-stream");
const { Readable, Transform, Writable, pipeline } = require("stream");
const pipelineAsync = require("util").promisify(pipeline);
const ensureBucketExists = require("./utils/createBucket");

const minioClient = new Minio.Client({
  endPoint: "minio",
  port: 80,
  useSSL: false,
  accessKey: "minioadmin",
  secretKey: "minioadmin",
});

class BatchStream extends Transform {
  constructor(batchSize) {
    super({ objectMode: true });
    this.batchSize = batchSize;
    this.batch = [];
  }

  _transform(chunk, encoding, callback) {
    this.batch.push(chunk);
    if (this.batch.length >= this.batchSize) {
      this.push(this.batch);
      this.batch = [];
    }
    callback();
  }

  _flush(callback) {
    if (this.batch.length > 0) {
      this.push(this.batch);
    }
    callback();
  }
}

class Parser extends Transform {
  constructor() {
    super({
      readableObjectMode: true,
      writableObjectMode: false,
    });
    this.counter = 0;
  }

  _transform(chunk, encoding, callback) {
    this.counter++;

    try {
      if (chunk.toString().length > 0) {
        const parsed = JSON.parse(chunk);
        callback(null, parsed);
      } else {
        callback();
      }
    } catch (err) {
      console.error(err);
      callback(err);
    }
  }
}

class HtmlBuilder extends Transform {
  constructor() {
    super({
      writableObjectMode: true,
      readableObjectMode: false,
    });
    this.headerWritten = false;
  }

  _transform(message, encoding, callback) {
    if (!this.headerWritten) {
      this.push(
        `<!DOCTYPE html><html><head><title>Conversation Export</title></head><body>`
      );
      this.push(`<h1>Conversation Export</h1>`);
      this.push(`<ul>`);
      this.headerWritten = true;
    }

    this.push(`<li><p>${message.messageText}</p></li>`);
    callback();
  }

  _flush(callback) {
    if (this.headerWritten) {
      this.push(`</ul></body></html>`);
    } else {
      this.push(
        `<!DOCTYPE html><html><head><title>Conversation Export</title></head><body>`
      );
      this.push(`<h1>Conversation Export</h1>`);
      this.push(`<p>No messages found</p>`);
      this.push(`</body></html>`);
    }
    callback();
  }
}

router.get("/token", (req, res) => {
  // Check request header for an Authorization header
  const authHeader = req.headers["authorization"];
  if (!authHeader || authHeader !== process.env.CHATBOT_SECRET) {
    return res.status(401).send("Unauthorized");
  }

  // Create a token with the JWT_SECRET
  const token = sign(
    {
      created: new Date().toISOString(),
    },
    process.env.JWT_SECRET,
    { expiresIn: "4hr" }
  );

  // Send the token in a cookie named "chatbot_token"
  res
    .cookie("chatbot_token", token, {
      httpOnly: true,
      secure: true,
      sameSite: "none",
    })
    .send("Token created");
});

router.post("/chat", async (req, res) => {
  try {
    // Extract token from a cookie named "chatbot_token"
    const token = req.cookies.chatbot_token;

    if (!token) {
      const noToken = new Error();
      noToken.status = 401;
      noToken.msg = "No token provided";
      throw noToken;
    }

    // Verify the token
    await verifyPromise(token, process.env.JWT_SECRET);

    const { message, thread_id, userId } = req.body;

    let threadId;
    let sequenceNumber;
    if (thread_id) {
      threadId = thread_id;

      // Find the current sequenceNumber
      const messages = await openai.beta.threads.messages.list(threadId);
      const currentSequenceNumber = messages.data.length;
      sequenceNumber = currentSequenceNumber + 1;

      // Conversation has already been started, add the message to the current thread
      await openai.beta.threads.messages.create(threadId, {
        role: "user",
        content: message,
      });

      // Record a new ConversationMessage of type role: "user"
      await prisma.conversation.update({
        where: {
          id: threadId,
        },
        data: {
          updatedAt: new Date(),
          messages: {
            create: {
              messageText: message,
              role: "user",
              sequenceNumber,
            },
          },
        },
      });
    } else {
      const newThread = await openai.beta.threads.create({
        messages: [
          {
            role: "user",
            content: message,
          },
        ],
      });
      threadId = newThread.id;

      // Record a new conversation
      await prisma.conversation.create({
        data: {
          id: threadId,
          userId,
        },
      });

      // Record a new ConversationMessage of type role: "user"
      await prisma.conversationMessage.create({
        data: {
          conversationId: threadId,
          messageText: message,
          role: "user",
          sequenceNumber: 1,
        },
      });
    }

    // Create a run with the thread id and the assistant id
    // Remember to create the assistant in the openAI dashboard

    const run = await openai.beta.threads.runs.create(threadId, {
      assistant_id: process.env.OPENAI_ASSISTANT_ID,
      tools: [{ type: "file_search" }],
    });

    // Wait for the completed status to be returned from the run (Poll every 5 seconds)

    let completed = false;
    while (!completed) {
      await sleep(5000);
      const asstRun = await openai.beta.threads.runs.retrieve(threadId, run.id);
      completed = asstRun.status === "completed";
      console.log("run status:", asstRun.status);
    }

    // Get the messages from the thread
    const messages = await openai.beta.threads.messages.list(threadId);
    const lastMessage = messages.data[0];

    // Record a new ConversationMessage of type role: "assistant"
    await prisma.conversation.update({
      where: {
        id: threadId,
      },
      data: {
        updatedAt: new Date(),
        messages: {
          create: {
            messageText: lastMessage.content[0].text.value,
            role: "assistant",
            sequenceNumber: sequenceNumber ? sequenceNumber + 1 : 2,
          },
        },
      },
    });

    return res.json({
      threadId,
      response: lastMessage.content[0].text.value,
    });
  } catch (error) {
    console.log(error);
    res
      .status(error.status || 500)
      .send(error.msg || `An error occurred: Please try again later.`);
  }
});

const MAX_RETRIES = 3;
router.get("/conversation/:id/messages", async (req, res) => {
  try {
    const conversationId = req.params.id;
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { archived: true },
    });

    if (!conversation) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    if (!conversation.archived) {
      return res.json(
        await prisma.conversationMessage.findMany({
          where: { conversationId },
        })
      );
    }

    // Retrieve archived messages from Minio
    const bucketName = "conversation-message-archives";
    const objectName = `${conversationId}_messages`;

    await prisma.$transaction(async (tx) => {
      const stream = await minioClient.getObject(bucketName, objectName);
      const parser = new Parser();
      const batchStream = new BatchStream(2);
      let first = true;

      const saveMessagesStream = new Writable({
        objectMode: true,
        async write(messages, encoding, callback) {
          try {
            await tx.conversationMessage.createMany({
              data: messages, // messages is an array of messages (batch)
              skipDuplicates: true,
            });

            // Write the message to the http response
            if (first) {
              let str = "";
              for (let i = 0; i < messages.length; i++) {
                str += JSON.stringify(messages[i]);
                if (i < messages.length - 1) {
                  str += ",";
                }
              }
              res.write(str);
            } else {
              let str = ",";
              for (let i = 0; i < messages.length; i++) {
                str += JSON.stringify(messages[i]);
                if (i < messages.length - 1) {
                  str += ",";
                }
              }
              res.write(str);
            }
            first = false;
            callback();
          } catch (err) {
            callback(err);
          }
        },
      });

      // Write headers for letting the client know im sending json
      res.setHeader("Content-Type", "application/json");
      // Write the opening bracket
      res.write("[");

      // Stream the data from Minio, split by new line, parse into JSON, and save to the database while sending to the client
      await pipelineAsync(
        stream,
        es.split(),
        parser,
        batchStream,
        saveMessagesStream
      );

      // Update the conversation to mark it as unarchived: retry if it fails, but do not rollback the transaction
      let retries = 0;
      while (retries < MAX_RETRIES) {
        try {
          await tx.conversation.update({
            where: { id: conversationId },
            data: { archived: false },
          });
          break; // exit the loop if the update is successful
        } catch (err) {
          retries++;
          if (retries >= MAX_RETRIES) {
            console.error(
              `Failed to update conversation ${conversationId} after ${MAX_RETRIES} retries. Error: ${err}`
            );
            break; // exit the loop and continue with the transaction
          }
          // wait for a short period of time before retrying
          await new Promise((resolve) => setTimeout(resolve, 250 * retries));
        }
      }
      // Remove the trailing comma
      res.write("]");
      res.end();
    });
  } catch (err) {
    console.error(err);

    // If the res has been started, end it
    if (!res.headersSent) {
      res
        .status(err.status || 500)
        .json({ error: err.msg || "An error occurred" });
    } else {
      res.write("An error occurred");
      res.end();
    }
  }
});

router.post("/conversation/:id/export", async (req, res) => {
  try {
    const threadId = req.params.id;
    const conversation = await prisma.conversation.findUnique({
      where: { id: threadId },
    });

    if (!conversation) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    // Create a readable stream for messages within the conversation
    let cursor;
    const readableStream = new Readable({
      objectMode: true,
      async read() {
        try {
          // Fetch a batch of messages for the current conversation
          const messages = await prisma.conversationMessage.findMany({
            where: { conversationId: threadId },
            take: 2, // adjust the batch size as needed
            skip: cursor ? 1 : 0,
            cursor: cursor ? { id: cursor } : undefined, // Use message ID as cursor
          });

          for (const message of messages) {
            this.push(message); // Push each message to the stream
          }

          if (messages.length < 2) {
            this.push(null); // Signal end of messages for this conversation
          } else {
            cursor = messages[messages.length - 1].id; // Update the cursor
          }
        } catch (err) {
          this.destroy(err);
        }
      },
    });

    // Create an HTML builder transform stream
    const htmlBuilder = new HtmlBuilder();
    readableStream.pipe(htmlBuilder);

    // Upload the static website to Minio
    const bucketName = "conversation-exports";
    const objectName = `${threadId}_export.html`;
    const metaData = {
      "Content-Type": "text/html",
    };

    await ensureBucketExists(minioClient, bucketName);
    await minioClient.putObject(bucketName, objectName, htmlBuilder, metaData);

    return res.json({ message: "Conversation exported successfully" });
  } catch (error) {
    console.log(error);
    res
      .status(error.status || 500)
      .send(error.msg || "An error occurred while exporting the conversation");
  }
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const verifyPromise = (token, secret) => {
  return new Promise((resolve, reject) => {
    verify(token, secret, (err, decoded) => {
      if (err) {
        const customError = new Error(err.message);
        customError.status = 401;
        customError.msg = "Unable to verify credentials";
        reject(customError);
      }
      resolve(decoded);
    });
  });
};

module.exports = router;
