import { secondFrameUrl } from './exerciseImage';

describe('secondFrameUrl', () => {
  it('swaps trailing /0.jpg for /1.jpg', () => {
    expect(
      secondFrameUrl(
        'https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Barbell_Bench_Press_-_Medium_Grip/0.jpg',
      ),
    ).toBe(
      'https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/Barbell_Bench_Press_-_Medium_Grip/1.jpg',
    );
  });

  it('returns null for URLs that do not end in /0.jpg', () => {
    expect(secondFrameUrl('https://example.com/img.png')).toBeNull();
    expect(secondFrameUrl('https://example.com/0.jpg/extra')).toBeNull();
    expect(secondFrameUrl('https://example.com/10.jpg')).toBeNull();
  });

  it('returns null for empty/missing input', () => {
    expect(secondFrameUrl(null)).toBeNull();
    expect(secondFrameUrl(undefined)).toBeNull();
    expect(secondFrameUrl('')).toBeNull();
  });
});
