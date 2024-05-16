import { PrismaClient } from "./prisma/client/index.js";
import { Readable } from "stream";
import { Transform } from "stream";
import * as Minio from "minio";
import yargs from "yargs";

const prisma = new PrismaClient();

const minioClient = new Minio.Client({
  endPoint: "minio",
  port: 80,
  useSSL: false,
  accessKey: "minioadmin",
  secretKey: "minioadmin",
});

class Serializer extends Transform {
  constructor() {
    super({
      readableObjectMode: false,
      writableObjectMode: true,
    });
    this.counter = 0;
  }

  _transform(chunk, encoding, callback) {
    this.counter++;
    callback(null, JSON.stringify(chunk) + "\n");
  }
}

async function main() {
  const argv = yargs(process.argv.slice(2)).demandOption(["th"]).argv;
  let archivalThreshold = argv.th;

  // Validate the format 'n MONTHS'
  if (!/^\d+ MONTHS$/.test(archivalThreshold)) {
    throw new Error(
      "Invalid archival threshold format. Format must be 'n MONTHS' where n is 0 or a positive integer."
    );
  }
  // Extract the digit from the string
  archivalThreshold = parseInt(archivalThreshold.split(" ")[0]);

  const bucketName = "conversation-message-archives";
  const bucketExists = new Promise((resolve, reject) => {
    minioClient.bucketExists(bucketName, function (err, exists) {
      if (err) reject(err);
      if (!exists) {
        minioClient.makeBucket(bucketName, function (err) {
          if (err) reject(err);
          resolve();
        });
      } else {
        resolve();
      }
    });
  });
  // Wait for the bucket to be created or confirmed
  await bucketExists;

  // 1. Fetch conversation IDs updated over n months ago
  const dateThreshold = new Date();
  dateThreshold.setMonth(dateThreshold.getMonth() - archivalThreshold);

  const ids = await prisma.conversation.findMany({
    select: {
      id: true,
    },
    where: {
      updatedAt: { lt: dateThreshold },
      messages: { some: {} },
    },
  });

  if (!ids.length) {
    console.log("No conversations to archive");
    return;
  }

  console.log(ids);

  // 2. Process each conversation ID
  for (const { id: conversationId } of ids) {
    let cursorValue;
    let take = 8;

    // 3. Create a readable stream for messages within the conversation
    const readableStream = new Readable({
      objectMode: true,
      async read() {
        try {
          // 3a. Fetch a batch of messages for the current conversation
          const messages = await prisma.conversationMessage.findMany({
            where: { conversationId },
            take,
            skip: cursorValue ? 1 : 0,
            cursor: cursorValue ? { id: cursorValue } : undefined, // Use message ID as cursor
          });

          for (const message of messages) {
            this.push(message); // Push each message to the stream
          }

          if (messages.length < take) {
            this.push(null); // Signal end of messages for this conversation
          } else {
            cursorValue = messages[messages.length - 1].id; // Update the cursor
          }
        } catch (err) {
          this.destroy(err);
        }
      },
    });

    // 4. Serialize the stream
    const serializer = new Serializer();
    const serializedStream = readableStream.pipe(serializer);

    // 5. Upload serialized messages to Minio
    const objectName = `${conversationId}_messages`;
    const uploadComplete = new Promise((resolve, reject) => {
      minioClient.putObject(
        bucketName,
        objectName,
        serializedStream,
        function (err, etag) {
          if (err) reject(err);
          resolve();
        }
      );
    });
    // Wait for the upload to complete
    await uploadComplete;
    console.log("**********************************************************");
    console.log(
      serializer.counter,
      "conversation messages archived in",
      objectName
    );
    console.log(
      "**********************************************************\n\n"
    );

    // 6. Delete archived messages from the database
    try {
      await prisma.conversation.update({
        where: { id: conversationId },
        data: {
          archived: true,
          messages: {
            deleteMany: {},
          },
        },
      });
      console.log(
        `Conversation ${conversationId} archived and messages deleted`
      );
    } catch (err) {
      console.error(`Error archiving conversation ${conversationId}: ${err}`);
      // Handle the error gracefully (e.g., retry later or log to a separate error file)
    }
  }
}

// Call main and handle errors by logging to console and exiting process
main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
