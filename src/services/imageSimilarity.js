const OpenAI = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Compare two images for visual similarity using GPT-4 Vision
 * Returns a similarity score between 0 and 100
 */
async function compareImageSimilarity(etsyImageUrl, aliexpressImageUrl) {
  try {
    console.log(`🤖 Comparing images with OpenAI Vision...`);

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 200,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `You are an expert product image comparator. Compare these two product images and determine their visual similarity.

Analyze:
- Product type and category
- Shape and design
- Colors and patterns  
- Style and aesthetics
- Overall visual match

Respond ONLY with a JSON object in this exact format:
{
  "similarity": <number 0-100>,
  "reasoning": "<brief 1-sentence explanation>"
}

Where similarity is:
- 90-100: Nearly identical (same product)
- 70-89: Very similar (same style/design)
- 60-69: Moderately similar (same category, similar look)
- 40-59: Somewhat similar (same category, different design)
- 0-39: Not similar`
            },
            {
              type: 'text',
              text: 'Image 1 (Etsy product):'
            },
            {
              type: 'image_url',
              image_url: {
                url: etsyImageUrl,
                detail: 'low'
              }
            },
            {
              type: 'text',
              text: 'Image 2 (AliExpress product):'
            },
            {
              type: 'image_url',
              image_url: {
                url: aliexpressImageUrl,
                detail: 'low'
              }
            }
          ]
        }
      ]
    });

    const content = response.choices[0].message.content.trim();
    
    // Parse JSON response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const result = JSON.parse(jsonMatch[0]);
      console.log(`✅ Similarity: ${result.similarity}% - ${result.reasoning}`);
      return {
        similarity: Math.min(100, Math.max(0, result.similarity)),
        reasoning: result.reasoning
      };
    } else {
      // Fallback: extract number from text
      const numMatch = content.match(/\d+/);
      const similarity = numMatch ? parseInt(numMatch[0]) : 0;
      return { similarity, reasoning: content };
    }
  } catch (error) {
    console.error('OpenAI comparison error:', error.message);
    return { similarity: 0, reasoning: 'Comparison failed: ' + error.message };
  }
}

/**
 * Compare an Etsy item against multiple AliExpress results
 * Returns pairs with similarity >= threshold
 */
async function compareEtsyWithAliexpress(etsyItem, aliexpressItems, threshold = 60) {
  const comparisons = [];

  for (const aliItem of aliexpressItems) {
    if (!etsyItem.image || !aliItem.image) {
      console.log(`⚠️ Skipping comparison - missing image`);
      continue;
    }

    try {
      const result = await compareImageSimilarity(
        etsyItem.hostedImageUrl || etsyItem.image,
        aliItem.image
      );

      if (result.similarity >= threshold) {
        comparisons.push({
          etsy: etsyItem,
          aliexpress: aliItem,
          similarity: result.similarity,
          reasoning: result.reasoning
        });
      }

      // Delay between API calls
      await new Promise(r => setTimeout(r, 500));
    } catch (error) {
      console.error('Comparison error:', error.message);
    }
  }

  // Sort by similarity descending
  return comparisons.sort((a, b) => b.similarity - a.similarity);
}

module.exports = { compareImageSimilarity, compareEtsyWithAliexpress };
