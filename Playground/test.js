const axios = require("axios");
const url = require("url");
var setCookie = require("set-cookie-parser");
const merge = require("deepmerge");
const querystring = require("querystring");

///////////////

const BASE_URL = process.env.BASE_URL;
const USERNAME = process.env.USERNAME;
const PASSWORD = process.env.PASSWORD;

//////////

async function makeLoginRequest() {
  const params = new url.URLSearchParams({
    username: USERNAME,
    password: PASSWORD,
  });
  const res = await axios.post(`${BASE_URL}/api/user/login`, params.toString());
  const cookies = setCookie.parse(res, {
    decodeValues: true, // default: true
  });
  return cookies.find(({ name }) => name === "auth_token");
}

async function getDocumentList(authToken) {
  async function makeRequest(offset) {
    const res = await axios.get(
      `${BASE_URL}/api/document/list?limit=100&offset=${offset}`,
      {
        headers: {
          Cookie: `${authToken.name}=${authToken.value};`,
        },
      }
    );
    return res.data;
  }
  const first = await makeRequest(0);
  const second = await makeRequest(100);
  const third = await makeRequest(200);
  const obj = merge(first, second, third);
  return obj.documents;
}

async function getDocumentFiles(authToken, documents) {
  async function makeRequest(id) {
    const res = await axios.get(`${BASE_URL}/api/file/list?id=${id}`, {
      headers: {
        Cookie: `${authToken.name}=${authToken.value};`,
      },
    });
    return res.data.files;
  }
  const files = await Promise.all(
    documents.map((document) => makeRequest(document.id))
  );
  return files.flat();
}

async function triggerFileReprocessing(authToken, files) {
  async function makeRequest(id) {
    const res = await axios({
      method: "post",
      url: `${BASE_URL}/api/file/${id}/process`,
      validateStatus: function (status) {
        return true; // Resolve only if the status code is less than 500
      },
      headers: {
        Cookie: `${authToken.name}=${authToken.value};`,
      },
    });
    return res.status;
  }
  const responses = await Promise.all(
    files.map((document) => makeRequest(document.id))
  );
  return {
    responses,
  };
}

async function triggerDocumentReprocessing(authToken, documents) {
  async function makeRequest(document) {
    console.log(`${BASE_URL}/api/document/${document.id}`, document);
    const res = await axios({
      method: "post",
      url: `${BASE_URL}/api/document/${document.id}`,
      validateStatus: function (status) {
        return true; // Resolve only if the status code is less than 500
      },
      headers: {
        Cookie: `${authToken.name}=${authToken.value};`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      data: querystring.stringify({
        ...document,
        tags: document.tags.map((tag) => tag.id),
      }),
    });
    return res.status;
  }
  const responses = await Promise.all(
    documents.map((document) => makeRequest(document))
  );
  return {
    responses,
  };
}

makeLoginRequest()
  .then(async (authToken) => {
    const documents = await getDocumentList(authToken);
    const documentReprocessing = await triggerDocumentReprocessing(
      authToken,
      documents
    );
    const files = await getDocumentFiles(authToken, documents);
    const fileReprocessing = await triggerFileReprocessing(authToken, files);
    return {
      fileReprocessing,
      documentReprocessing,
      files,
    };
  })
  .then((x) => console.log(JSON.stringify(x, null, 4)));
