import { Request, Response, NextFunction } from 'express';

export function authMiddleware(authToken: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res
        .status(401)
        .json({ error: 'Authorization header is required' });
    }

    const [type, token] = authHeader.split(' ');

    if (type !== 'Bearer') {
      return res
        .status(401)
        .json({ error: 'Authorization type must be Bearer' });
    }

    if (token !== authToken) {
      return res.status(401).json({ error: 'Invalid authentication token' });
    }

    next();
  };
}
