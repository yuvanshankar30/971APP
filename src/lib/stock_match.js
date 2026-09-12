// Matches a BOM part's material + dimensions against one workflow's real
// stock shapes: sheet thickness (laser-cut, and router sheet goods), tube
// outer width/height (router tube stock), diameter/hex-size (lathe bar
// stock), or plain material match (mill/3d-print, which stock.json doesn't
// otherwise distinguish by shape).
export function matchStockInWorkflow(stockData, workflow, material, minDim, midDim, maxDim, dimX, dimY) {
  const workflowStocks = stockData[workflow] || [];
  let bestMatch = null;

  for (const stock of workflowStocks) {
    if (!material.includes(stock.material.toLowerCase())) continue;

    if (workflow === 'laser-cut' || (workflow === 'router' && stock.dimensions === 'Sheet')) {
      // Match by thickness for sheet materials
      if (stock.thickness && Math.abs(minDim - stock.thickness) < 0.1) {
        bestMatch = stock;
        break;
      }
    } else if (workflow === 'lathe') {
      // Match by diameter for round stock
      if (stock.diameter && Math.abs(maxDim - stock.diameter) < 0.1) {
        bestMatch = stock;
        break;
      } else if (stock.diameter_max && maxDim < stock.diameter_max) {
        bestMatch = stock;
      } else if (stock.diameter_min && maxDim > stock.diameter_min) {
        bestMatch = stock;
      } else if (stock.hex_size) {
        // ThunderHex matching
        if (Math.abs(maxDim - stock.hex_size) < 0.1 && midDim < stock.length_max) {
          bestMatch = stock;
          break;
        }
      }
    } else if (workflow === 'router') {
      // Match tube stock
      if (stock.outer_width && stock.outer_height) {
        if ((Math.abs(dimX - stock.outer_width) < 0.1 && Math.abs(dimY - stock.outer_height) < 0.1) ||
            (Math.abs(dimX - stock.outer_height) < 0.1 && Math.abs(dimY - stock.outer_width) < 0.1)) {
          bestMatch = stock;
          break;
        }
      }
    } else {
      // Default material match for mill and 3d-print
      bestMatch = stock;
      break;
    }
  }

  // Fallback to first material match if no exact match
  if (!bestMatch) {
    bestMatch = workflowStocks.find((stock) => material.includes(stock.material.toLowerCase()));
  }

  return bestMatch;
}

// Picks a stock item for a manufactured part, preferring a router-stock
// match over the "mill" default when the part was only guessed as mill -
// mill has no real dimensional check of its own (bom_classify.js's plain
// "anything not otherwise matched" fallback bucket, matching on material
// name alone), so it will happily claim a part that's actually an exact
// dimensional match (sheet thickness, tube outer width/height) for real
// router stock. lathe/router/3d-print guesses come from more specific
// name/material rules already, so they're trusted as-is. Direct
// instruction: anything already in the router stock list should be
// assigned the router workflow.
export function pickStockAndWorkflow(stockData, part) {
  const material = (part.material || '').toLowerCase();
  const dimX = part.bounding_box_x * 39.3701; // meters to inches
  const dimY = part.bounding_box_y * 39.3701;
  const dimZ = part.bounding_box_z * 39.3701;
  const [minDim, midDim, maxDim] = [dimX, dimY, dimZ].sort((a, b) => a - b);

  if (part.workflow === 'mill') {
    const routerMatch = matchStockInWorkflow(stockData, 'router', material, minDim, midDim, maxDim, dimX, dimY);
    if (routerMatch) {
      return { stock: routerMatch, workflow: 'router' };
    }
  }

  const stock = matchStockInWorkflow(stockData, part.workflow, material, minDim, midDim, maxDim, dimX, dimY);
  return { stock, workflow: part.workflow };
}
