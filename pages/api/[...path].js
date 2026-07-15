const handleRequest = require("../../server");

function handler(req, res) {
  return handleRequest(req, res);
}

module.exports = handler;
module.exports.config = {
  api: {
    bodyParser: false,
    externalResolver: true,
  },
};
