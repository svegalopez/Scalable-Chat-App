module.exports = async function ensureBucketExists(minioClient, bucketName) {
  return new Promise((resolve, reject) => {
    minioClient.bucketExists(bucketName, function (err, exists) {
      if (err) reject(err);
      if (exists) return resolve();

      minioClient.makeBucket(bucketName, function (err) {
        if (err) reject(err);
        resolve();
      });
    });
  });
};
