require("dotenv").config();
const cors = require("cors");

const express = require("express");
const app = express();

// Enable cors
app.use(
  cors({
    origin: process.env.CLIENT_URL,
    credentials: true,
  })
);

// Enable cookie parsing
app.use(require("cookie-parser")());

// Enable JSON parsing
app.use(express.json());

app.use(require("./chatbot"));

// Add a 404 route
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.listen(3089, () => {
  console.log("Server is running on port 3089");
});
