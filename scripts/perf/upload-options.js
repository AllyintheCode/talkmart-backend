export function uploadMatrix(sizes = "20,35,50", concurrencies = "5,10,25") {
  const parse = (value, allowed) => {
    const numbers = String(value).split(",").map(item => Number(item));
    if (!numbers.length || numbers.length > 3 || numbers.some(number => !allowed.includes(number))) throw new Error("INVALID_LOCAL_UPLOAD_MATRIX");
    return [...new Set(numbers)];
  };
  return { sizes: parse(sizes, [20, 35, 50]), concurrencies: parse(concurrencies, [5, 10, 25]) };
}
