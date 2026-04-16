// Les images Etsy (i.etsystatic.com) sont publiques — on les passe directement à Serper.
// Plus besoin d'ImgBB ni de proxy pour Google Lens.
function uploadToImgBB(input) {
  return Promise.resolve(input);
}

module.exports = { uploadToImgBB };
